/** Isolated phase-0 schema probe, not a production XSD validator or a runtime service. */
const XSD = 'http://www.w3.org/2001/XMLSchema';

export interface SchemaLayer {
  featureType: string | string[];
  getCapabilitiesPromise(): Promise<unknown>;
  getDescribeFeatureTypeUrl(types: string | string[]): string;
  proxificationTool: { fetchXML(url: string): Promise<Document> };
}

export interface SchemaDocuments {
  root: Document;
  documents: Document[];
  issues: string[];
}

function children(element: Element, name?: string): Element[] {
  return Array.from(element.children).filter(child =>
    child.namespaceURI === XSD && (!name || child.localName === name));
}

function schemaRoot(document: Document): Element {
  const root = document.documentElement;
  if (!root || root.namespaceURI !== XSD || root.localName !== 'schema') {
    throw new Error('DescribeFeatureType did not return an XSD schema');
  }
  return root;
}

/** Dependencies are denied unless explicitly authorized or supplied as bundled XML. */
export async function loadSchemaProbe(layer: SchemaLayer, options: {
  bundled?: ReadonlyMap<string, Document>;
  allowDependency?: (url: string) => boolean;
  maxDocuments?: number;
  maxDepth?: number;
  timeoutMs?: number;
} = {}): Promise<SchemaDocuments> {
  const documents: Document[] = [];
  const issues: string[] = [];
  const visited = new Map<string, Document>();
  const limit = options.maxDocuments ?? 12;
  const maxDepth = options.maxDepth ?? 4;
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Schema deadline exceeded');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Schema deadline exceeded')), remaining);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function visit(url: string, depth: number, ancestors: ReadonlySet<string>): Promise<Document> {
    if (ancestors.has(url)) throw new Error('Cyclic schema dependency');
    const cached = visited.get(url);
    if (cached) return cached;
    if (depth > maxDepth || visited.size >= limit) throw new Error('Schema dependency limit exceeded');
    const bundled = options.bundled?.get(url);
    if (depth && !bundled && !options.allowDependency?.(url)) {
      throw new Error('Schema dependency is not explicitly authorized');
    }
    const document = bundled ?? await bounded(() => layer.proxificationTool.fetchXML(url));
    const root = schemaRoot(document);
    visited.set(url, document);
    documents.push(document);
    const next = new Set([...ancestors, url]);
    for (const dependency of children(root).filter(node => ['include', 'import'].includes(node.localName))) {
      try {
        const location = dependency.getAttribute('schemaLocation');
        if (!location) throw new Error('Schema dependency has no location');
        const dependencyUrl = new URL(location, url).href;
        const parsed = new URL(dependencyUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error('Unsupported schema dependency URL');
        }
        const imported = await visit(dependencyUrl, depth + 1, next);
        const expectedNamespace = dependency.localName === 'include'
          ? root.getAttribute('targetNamespace') : dependency.getAttribute('namespace');
        if (schemaRoot(imported).getAttribute('targetNamespace') !== expectedNamespace) {
          throw new Error('Schema dependency namespace mismatch');
        }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : 'Schema dependency failed');
      }
    }
    return document;
  }
  await bounded(() => layer.getCapabilitiesPromise());
  const root = await visit(layer.getDescribeFeatureTypeUrl(layer.featureType), 0, new Set());
  return { root, documents, issues };
}

export interface FieldProbe {
  name: string;
  namespace: string;
  type: string | null;
  minOccurs: string;
  maxOccurs: string;
  nillable: boolean;
  defaultValue: string | null;
  fixedValue: string | null;
  facets: Array<{ name: string; value: string }>;
  reasons: string[];
}

/** Only direct sequences and local/named restrictions of string, boolean and int. */
export function inspectSchemaProbe(
  schemas: SchemaDocuments, namespace: string, featureName: string
): { fields: FieldProbe[]; issues: string[] } {
  const issues = [...schemas.issues];
  const roots = schemas.documents.map(schemaRoot);
  function declaration(ns: string, name: string, kind: string): Element | undefined {
    const matches = roots.filter(root => root.getAttribute('targetNamespace') === ns)
      .flatMap(root => children(root, kind)).filter(node => node.getAttribute('name') === name);
    if (matches.length > 1) throw new Error('Ambiguous schema declaration');
    return matches[0];
  }
  function qname(node: Element, value: string): [string, string] {
    const parts = value.split(':');
    const ns = node.lookupNamespaceURI(parts.length === 2 ? parts[0] : null);
    if (!ns || parts.length > 2 || !parts.at(-1)) throw new Error('Unresolved schema QName');
    return [ns, parts.at(-1)!];
  }
  function simpleType(node: Element, field: FieldProbe, ancestors: Set<Element>): void {
    if (ancestors.has(node)) throw new Error('Cyclic simple type');
    const next = new Set([...ancestors, node]);
    const content = children(node).filter(child => child.localName !== 'annotation');
    if (content.length !== 1 || content[0].localName !== 'restriction') {
      throw new Error('Unsupported simple type construction');
    }
    const restriction = content[0];
    resolveType(restriction, restriction.getAttribute('base') ?? '', field, next);
    const supported = new Set(['enumeration', 'length', 'minLength', 'maxLength',
      'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'totalDigits', 'fractionDigits']);
    for (const facet of children(restriction)) {
      if (facet.localName === 'annotation') continue;
      const value = facet.getAttribute('value');
      if (!supported.has(facet.localName) || value === null) {
        throw new Error(`Unsupported XSD facet: ${facet.localName}`);
      }
      field.facets.push({ name: facet.localName, value });
    }
  }
  function resolveType(node: Element, value: string, field: FieldProbe, ancestors: Set<Element>): void {
    const [ns, name] = qname(node, value);
    if (ns === XSD) {
      if (!['string', 'boolean', 'int'].includes(name)) throw new Error(`Unverified XSD type: ${name}`);
      field.type = name;
      return;
    }
    const type = declaration(ns, name, 'simpleType');
    if (!type) throw new Error('Unresolved or complex attribute type');
    simpleType(type, field, ancestors);
  }
  const element = declaration(namespace, featureName, 'element');
  if (!element) throw new Error('Feature element not found in schema');
  const inline = children(element, 'complexType')[0];
  const typeName = element.getAttribute('type');
  const complex = inline ?? (typeName ? declaration(...qname(element, typeName), 'complexType') : undefined);
  if (!complex) throw new Error('Feature complex type not resolved');
  // Report extension fields for inspection, but do not certify inheritance as resolved.
  const extension = children(complex, 'complexContent').flatMap(node => children(node, 'extension'))[0];
  if (extension) issues.push('Complex type inheritance requires native/GML metadata reconciliation');
  const container = extension ?? complex;
  const structural = children(container).filter(node => node.localName !== 'annotation');
  if (structural.length !== 1 || structural[0].localName !== 'sequence' ||
      Array.from(structural[0].attributes).some(attr => !['minOccurs', 'maxOccurs'].includes(attr.name)) ||
      ['minOccurs', 'maxOccurs'].some(name => ![null, '1'].includes(structural[0].getAttribute(name)))) {
    throw new Error('Unsupported feature content model');
  }
  const fields = children(structural[0]).filter(node => node.localName !== 'annotation').map(node => {
    if (node.localName !== 'element' || !node.getAttribute('name') || node.hasAttribute('ref')) {
      throw new Error('Unresolved feature field structure');
    }
    const field: FieldProbe = {
      name: node.getAttribute('name')!,
      namespace: (node.getAttribute('form') ?? schemaRoot(node.ownerDocument).getAttribute('elementFormDefault')) === 'qualified'
        ? namespace : '',
      type: null, minOccurs: node.getAttribute('minOccurs') ?? '1',
      maxOccurs: node.getAttribute('maxOccurs') ?? '1',
      nillable: ['true', '1'].includes(node.getAttribute('nillable') ?? ''),
      defaultValue: node.getAttribute('default'), fixedValue: node.getAttribute('fixed'),
      facets: [], reasons: []
    };
    try {
      const unknown = Array.from(node.attributes).filter(attr =>
        !['name', 'type', 'minOccurs', 'maxOccurs', 'nillable', 'default', 'fixed', 'form'].includes(attr.name));
      if (unknown.length) throw new Error('Unverified field declaration attributes');
      if (![null, 'true', 'false', '1', '0'].includes(node.getAttribute('nillable')) ||
          ![null, 'qualified', 'unqualified'].includes(node.getAttribute('form'))) {
        throw new Error('Invalid field declaration values');
      }
      if (!['0', '1'].includes(field.minOccurs) || field.maxOccurs !== '1') {
        throw new Error('Repeated or unsupported field occurrence');
      }
      const content = children(node).filter(child => child.localName !== 'annotation');
      if (node.hasAttribute('type') && content.length === 0) {
        resolveType(node, node.getAttribute('type')!, field, new Set());
      } else if (!node.hasAttribute('type') && content.length === 1 && content[0].localName === 'simpleType') {
        simpleType(content[0], field, new Set());
      } else {
        throw new Error('Unsupported field type definition');
      }
      if (field.fixedValue !== null) field.reasons.push('Fixed field is not a free input');
    } catch (error) {
      field.reasons.push(error instanceof Error ? error.message : 'Unresolved field');
    }
    return field;
  });
  return { fields, issues };
}
