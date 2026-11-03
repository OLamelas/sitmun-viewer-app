import { bundledWfsSchema } from './bundled-wfs-schemas';
import { attributeValuesEqual } from './feature-attribute-draft';

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema';

export interface WfsAttributeFacet {
  name: string;
  value: string;
}

export interface WfsAttributeField {
  name: string;
  namespace: string;
  type: string | null;
  /** Item type of an XSD whitespace-separated list (not a repeated element). */
  itemType?: string;
  minOccurs: string;
  maxOccurs: string;
  nillable: boolean;
  defaultValue: string | null;
  fixedValue: string | null;
  facets: WfsAttributeFacet[];
  reasons: string[];
  /** Whether the declaration came from a base feature type. */
  inherited?: boolean;
}

export interface WfsAttributeSchema {
  featureType: string;
  fields: WfsAttributeField[];
  issues: string[];
  namespaces?: Record<string, string>;
}

export interface WfsSchemaLayer {
  featureType: string | string[];
  featureNS?: string;
  options?: { featureNS?: string };
  getCapabilitiesPromise(): Promise<unknown>;
  getDescribeFeatureTypeUrl(layerNames?: string | string[]): string;
  proxificationTool: {
    fetchXML(url: string): Promise<Document>;
  };
}

export interface WfsFeatureTypeIdentity {
  namespaceURI: string;
  localName: string;
}

/** Resolve only the requested layer identity, never the QNames inside XSD. */
export function resolveWfsFeatureType(
  layer: Pick<WfsSchemaLayer, 'featureType' | 'featureNS' | 'options'>,
  documents: Document[],
  capabilities: unknown
): WfsFeatureTypeIdentity {
  const names = Array.isArray(layer.featureType) ? layer.featureType : [layer.featureType];
  if (names.length !== 1 || !names[0]) throw new Error('A single WFS feature type is required');
  const parts = names[0].split(':');
  if (parts.length > 2 || parts.some((part) => !part)) throw new Error('Invalid WFS feature type');
  const root = getSchemaRoot(documents[0]);
  const target = root.getAttribute('targetNamespace');
  if (!target) throw new Error('Missing feature target namespace');
  const namespaceFor = (prefix: string): string => {
    const fromSchema = root.lookupNamespaceURI(prefix);
    const fromCapabilities = (capabilities as Record<string, unknown> | null)?.[`xmlns:${prefix}`];
    if (fromSchema && fromCapabilities && fromSchema !== fromCapabilities) {
      throw new Error(`Contradictory WFS namespace: ${prefix}`);
    }
    const uri = fromSchema ?? fromCapabilities;
    if (typeof uri !== 'string' || !uri) throw new Error(`Unknown WFS namespace prefix: ${prefix}`);
    return uri;
  };
  const nativePrefix = layer.featureNS ?? layer.options?.featureNS;
  const namespaceURI = parts.length === 2 ? namespaceFor(parts[0])
    : nativePrefix ? namespaceFor(nativePrefix) : undefined;
  if (!namespaceURI) throw new Error('Missing native WFS namespace evidence');
  if (namespaceURI !== target || nativePrefix && namespaceFor(nativePrefix) !== namespaceURI) {
    throw new Error('WFS feature namespace does not match DescribeFeatureType');
  }
  if (layer.featureNS && layer.options?.featureNS && namespaceFor(layer.options.featureNS) !== namespaceURI) {
    throw new Error('Contradictory native WFS namespace configuration');
  }
  const localName = parts.at(-1)!;
  const matches = documents.map(getSchemaRoot)
    .filter((schema) => schema.getAttribute('targetNamespace') === namespaceURI)
    .flatMap((schema) => xsdChildren(schema, 'element'))
    .filter((element) => element.getAttribute('name') === localName);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous WFS feature declaration: ${localName}`);
  return { namespaceURI, localName };
}

export interface WfsSchemaLoadOptions {
  maxDocuments?: number;
  maxDepth?: number;
  timeoutMs?: number;
}

function xsdChildren(element: Element, name?: string): Element[] {
  return Array.from(element.children).filter(
    (child) =>
      child.namespaceURI === XSD_NAMESPACE &&
      (name === undefined || child.localName === name)
  );
}

function optionalAttribute(element: Element, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null;
}

function getSchemaRoot(document: Document): Element {
  const root = document.documentElement;
  if (!root || root.namespaceURI !== XSD_NAMESPACE || root.localName !== 'schema') {
    throw new Error('DescribeFeatureType did not return an XSD schema');
  }
  return root;
}

function resolveQName(node: Element, value: string): [string, string] {
  const parts = value.split(':');
  const localName = parts.at(-1);
  const namespace = node.lookupNamespaceURI(parts.length === 2 ? parts[0] : null);
  if (!namespace || !localName || parts.length > 2) {
    throw new Error(`Unresolved schema QName: ${value}`);
  }
  return [namespace, localName];
}

/**
 * Read the original XSD using SITNA's established capabilities and proxy path.
 * Network imports stay on the DescribeFeatureType origin. Exact standard schemas
 * may instead be resolved from SITNA's local dictionary, including GeoServer aliases.
 */
export async function loadWfsAttributeSchema(
  layer: WfsSchemaLayer,
  options: WfsSchemaLoadOptions = {}
): Promise<{ document: Document; documents: Document[]; issues: string[]; capabilities: unknown }> {
  const featureTypes = Array.isArray(layer.featureType)
    ? [...layer.featureType]
    : [layer.featureType];
  if (featureTypes.length !== 1 || !featureTypes[0]) {
    throw new Error('A single WFS feature type is required to inspect its schema');
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  const maxDocuments = options.maxDocuments ?? 8;
  const maxDepth = options.maxDepth ?? 3;
  let rootUrl: string;
  let rootOrigin: string;
  const documents: Document[] = [];
  const issues: string[] = [];
  const cache = new Map<string, Document>();
  let networkDocuments = 0;
  let bundledDocuments = 0;

  const bounded = async <T>(request: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Schema request deadline exceeded');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Schema request deadline exceeded')),
            remaining
          );
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };

  const visit = async (
    url: string,
    depth: number,
    expectedNamespace?: string | null
  ): Promise<Document> => {
    const parsedUrl = new URL(url, rootUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error('Schema dependency is outside the authorized service origin');
    }
    const bundled = depth > 0 ? await bounded(() => bundledWfsSchema(parsedUrl)) : undefined;
    const key = bundled?.url ?? parsedUrl.href;
    const cached = cache.get(key);
    if (cached) {
      if (expectedNamespace !== undefined && getSchemaRoot(cached).getAttribute('targetNamespace') !== expectedNamespace) {
        throw new Error('Schema dependency namespace mismatch');
      }
      return cached; // XSD include graphs (including standard GML) can be cyclic.
    }
    if (bundled) {
      if (++bundledDocuments > 64) throw new Error('Bundled schema dependency limit exceeded');
    } else {
      // A bundled document must not turn its own external imports into network access.
      if (depth > 0 && parsedUrl.origin !== rootOrigin) {
        throw new Error('Schema dependency is outside the authorized service origin');
      }
      if (depth > maxDepth || ++networkDocuments > maxDocuments) throw new Error('Schema dependency limit exceeded');
    }
    const schema = bundled
      ? new DOMParser().parseFromString(bundled.xml, 'application/xml')
      : await bounded(() => layer.proxificationTool.fetchXML(parsedUrl.href));
    const root = getSchemaRoot(schema);
    if (expectedNamespace !== undefined && root.getAttribute('targetNamespace') !== expectedNamespace) {
      throw new Error('Schema dependency namespace mismatch');
    }
    cache.set(key, schema);
    documents.push(schema);

    for (const dependency of xsdChildren(root).filter((child) =>
      ['include', 'import'].includes(child.localName)
    )) {
      try {
        const location = dependency.getAttribute('schemaLocation');
        if (!location) throw new Error('Schema dependency has no location');
        const dependencyUrl = new URL(location, key).href;
        const expectedNamespace =
          dependency.localName === 'include'
            ? root.getAttribute('targetNamespace')
            : dependency.getAttribute('namespace');
        await visit(dependencyUrl, depth + 1, expectedNamespace);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : 'Schema dependency failed');
      }
    }
    return schema;
  };

  const capabilities = await bounded(() => layer.getCapabilitiesPromise());
  // Native URL resolution depends on the negotiated WFS capabilities/version.
  rootUrl = new URL(layer.getDescribeFeatureTypeUrl(featureTypes), document.baseURI).href;
  rootOrigin = new URL(rootUrl).origin;
  const rootDocument = await visit(rootUrl, 0);
  return { document: rootDocument, documents, issues, capabilities };
}

/** Resolve field structure; the WFS remains authoritative for XSD validation. */
export function parseWfsAttributeSchema(
  documents: Document[],
  featureType: string | WfsFeatureTypeIdentity,
  dependencyIssues: string[] = []
): WfsAttributeSchema {
  const roots = documents.map(getSchemaRoot);
  if (!roots.length) throw new Error('No XSD documents were loaded');
  const issues = [...dependencyIssues];

  const declaration = (
    namespace: string,
    name: string,
    kind: 'element' | 'complexType' | 'simpleType' | 'group'
  ): Element | undefined => {
    const matches = roots
      .filter((root) => root.getAttribute('targetNamespace') === namespace)
      .flatMap((root) => xsdChildren(root, kind))
      .filter((node) => node.getAttribute('name') === name);
    if (matches.length > 1) throw new Error(`Ambiguous XSD declaration: ${name}`);
    return matches[0];
  };

  const root = roots[0];
  const [featureNamespace, featureName] = typeof featureType === 'string'
    ? resolveQName(root, featureType) : [featureType.namespaceURI, featureType.localName];
  const featureElement = declaration(featureNamespace, featureName, 'element');
  if (!featureElement) throw new Error(`Feature element not found: ${featureType}`);

  const inlineType = xsdChildren(featureElement, 'complexType')[0];
  const qualifiedType = featureElement.getAttribute('type');
  const complexType =
    inlineType ??
    (qualifiedType
      ? declaration(...resolveQName(featureElement, qualifiedType), 'complexType')
      : undefined);
  if (!complexType) throw new Error(`Feature complex type not resolved: ${featureType}`);

  const declarations: { element: Element; inherited: boolean }[] = [];
  const collect = (node: Element, inherited: boolean, ancestors: Set<Element>): void => {
    if (ancestors.has(node) || ancestors.size >= 32) throw new Error('Cyclic or excessive complex type inheritance');
    const next = new Set([...ancestors, node]);
    if (['complexType', 'complexContent', 'extension'].includes(node.localName) &&
        (node.getAttribute('mixed') === 'true' || node.getAttribute('mixed') === '1' ||
         Array.from(node.attributes).some((attribute) => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/' &&
           !['name', 'abstract', 'base', 'mixed'].includes(attribute.name)))) {
      throw new Error('Unsupported feature type attributes');
    }
    const children = xsdChildren(node).filter((child) => child.localName !== 'annotation');
    if (['complexType', 'extension'].includes(node.localName) &&
        children.filter((child) => !['attribute', 'attributeGroup', 'anyAttribute'].includes(child.localName)).length > 1) {
      throw new Error('Unsupported feature content model');
    }
    for (const child of children) {
      if (child.localName === 'complexContent') {
        const content = xsdChildren(child).filter((item) => item.localName !== 'annotation');
        if (content.length !== 1 || content[0].localName !== 'extension') throw new Error('Unsupported complex type derivation');
        const extension = content[0];
        const base = declaration(...resolveQName(extension, extension.getAttribute('base') ?? ''), 'complexType');
        if (!base) throw new Error('Complex type inheritance is not fully resolved');
        collect(base, true, next);
        collect(extension, inherited, next);
      } else if (child.localName === 'sequence' || child.localName === 'group') {
        if (Array.from(child.attributes).some((attribute) => !['minOccurs', 'maxOccurs', 'ref'].includes(attribute.name)) ||
            (optionalAttribute(child, 'minOccurs') ?? '1') !== '1' ||
            (optionalAttribute(child, 'maxOccurs') ?? '1') !== '1') throw new Error('Unsupported feature content model');
        const ref = child.getAttribute('ref');
        if (ref) {
          if (child.localName !== 'group') throw new Error('Unsupported feature content model');
          const group = declaration(...resolveQName(child, ref), 'group');
          if (!group) throw new Error('Unresolved feature group');
          collect(group, inherited, next);
        } else collect(child, inherited, next);
      } else if (child.localName === 'element') {
        declarations.push({ element: child, inherited });
      } else if (!inherited ||
          !['http://www.opengis.net/gml', 'http://www.opengis.net/gml/3.2'].includes(getSchemaRoot(node.ownerDocument).getAttribute('targetNamespace') ?? '') ||
          !['attribute', 'attributeGroup', 'anyAttribute'].includes(child.localName)) {
        throw new Error('Unsupported feature content model');
      }
    }
  };
  try { collect(complexType, false, new Set()); }
  catch (error) {
    // Keep the local sequence visible, but never enable inputs with an unresolved base.
    issues.push(error instanceof Error ? error.message : 'Unsupported feature content model');
    declarations.length = 0;
    const extension = xsdChildren(complexType, 'complexContent').flatMap((node) => xsdChildren(node, 'extension'))[0];
    const sequence = xsdChildren(extension ?? complexType, 'sequence')[0];
    if (!sequence) throw error;
    for (const element of xsdChildren(sequence, 'element')) declarations.push({ element, inherited: false });
  }

  function resolveSimpleType(
    node: Element,
    field: WfsAttributeField,
    ancestors: Set<Element>
  ): void {
    if (ancestors.has(node)) throw new Error('Cyclic simple type');
    const nextAncestors = new Set([...ancestors, node]);
    const items = xsdChildren(node).filter((child) => child.localName !== 'annotation');
    if (items.length === 1 && items[0].localName === 'list') {
      const list = items[0];
      const item = { ...field, facets: [], reasons: [] };
      const inline = xsdChildren(list, 'simpleType')[0];
      if (inline) resolveSimpleType(inline, item, nextAncestors);
      else resolveType(list, list.getAttribute('itemType') ?? '', item, nextAncestors);
      field.type = 'list';
      field.itemType = item.type ?? undefined;
      return;
    }
    if (items.length === 1 && items[0].localName === 'union') {
      field.type = 'union';
      return;
    }
    if (items.length !== 1 || items[0].localName !== 'restriction') {
      throw new Error('Unsupported simple type construction');
    }
    const restriction = items[0];
    resolveType(restriction, restriction.getAttribute('base') ?? '', field, nextAncestors);
    const narrowsEnumeration = field.facets.some((facet) => facet.name === 'enumeration') &&
      xsdChildren(restriction, 'enumeration').length > 0;
    if (narrowsEnumeration) {
      // A restriction narrows its base; never turn two enumeration levels into a union.
      const allowed = xsdChildren(restriction, 'enumeration').map((facet) => facet.getAttribute('value'));
      field.facets = field.facets.filter((facet) => facet.name !== 'enumeration' || allowed.some((value) =>
        value !== null && attributeValuesEqual({ ...field, facets: [], fixedValue: null }, facet.value, value)));
      if (!field.facets.some((facet) => facet.name === 'enumeration')) throw new Error('Empty enumeration restriction');
    }
    for (const facet of xsdChildren(restriction)) {
      if (facet.localName === 'annotation') continue;
      const value = facet.getAttribute('value');
      if (value === null) throw new Error(`Invalid XSD facet: ${facet.localName}`);
      if (facet.localName === 'enumeration' && narrowsEnumeration) continue;
      field.facets.push({ name: facet.localName, value });
    }
  }

  function resolveType(
    node: Element,
    value: string,
    field: WfsAttributeField,
    ancestors: Set<Element>
  ): void {
    const [namespace, name] = resolveQName(node, value);
    if (namespace === XSD_NAMESPACE) {
      const listItems: Record<string, string> = { NMTOKENS: 'NMTOKEN', IDREFS: 'IDREF', ENTITIES: 'ENTITY' };
      field.type = listItems[name] ? 'list' : name;
      field.itemType = listItems[name];
      return;
    }
    const type = declaration(namespace, name, 'simpleType');
    if (!type) {
      if (declaration(namespace, name, 'complexType')) {
        field.type = 'complex';
        return;
      }
      throw new Error('Unresolved attribute type');
    }
    resolveSimpleType(type, field, ancestors);
  }

  const fields = declarations.map(({ element: particle, inherited }) => {
    const ref = particle.getAttribute('ref');
    const element = ref ? declaration(...resolveQName(particle, ref), 'element') : particle;
    const name = element?.getAttribute('name');
    if (!element || !name) {
      throw new Error('Unresolved feature field structure');
    }
    const form = optionalAttribute(element, 'form') ??
      optionalAttribute(getSchemaRoot(element.ownerDocument), 'elementFormDefault') ??
      'unqualified';
    const namespace = ref || form === 'qualified'
      ? getSchemaRoot(element.ownerDocument).getAttribute('targetNamespace') ?? '' : '';
    const infrastructure = inherited && ['http://www.opengis.net/gml', 'http://www.opengis.net/gml/3.2'].includes(namespace);
    const field: WfsAttributeField = {
      name,
      namespace,
      type: null,
      minOccurs: optionalAttribute(particle, 'minOccurs') ?? '1',
      maxOccurs: optionalAttribute(particle, 'maxOccurs') ?? '1',
      nillable: ['true', '1'].includes(optionalAttribute(element, 'nillable') ?? 'false'),
      defaultValue: optionalAttribute(element, 'default'),
      fixedValue: optionalAttribute(element, 'fixed'),
      facets: [],
      reasons: infrastructure ? ['Inherited infrastructure field'] : [],
      inherited
    };
    try {
      const knownAttributes = new Set([
        'name', 'type', 'minOccurs', 'maxOccurs', 'nillable', 'default', 'fixed', 'form'
      ]);
      if (Array.from(element.attributes).some((attribute) => !knownAttributes.has(attribute.name))) {
        throw new Error('Unverified field declaration attributes');
      }
      if (ref && Array.from(particle.attributes).some((attribute) => !['ref', 'minOccurs', 'maxOccurs'].includes(attribute.name))) {
        throw new Error('Unverified field reference attributes');
      }
      if (
        ![null, 'true', 'false', '1', '0'].includes(optionalAttribute(element, 'nillable')) ||
        ![null, 'qualified', 'unqualified'].includes(optionalAttribute(element, 'form'))
      ) {
        throw new Error('Invalid field declaration values');
      }
      if (!/^\d+$/.test(field.minOccurs) || !/^(\d+|unbounded)$/.test(field.maxOccurs)) throw new Error('Invalid field occurrence');
      const nested = xsdChildren(element).filter((child) => child.localName !== 'annotation');
      if (element.hasAttribute('type') && nested.length === 0) {
        resolveType(element, element.getAttribute('type')!, field, new Set());
      } else if (
        !element.hasAttribute('type') &&
        nested.length === 1 &&
        nested[0].localName === 'simpleType'
      ) {
        resolveSimpleType(nested[0], field, new Set());
      } else if (!element.hasAttribute('type') && nested.length === 1 && nested[0].localName === 'complexType') {
        field.type = 'complex';
      } else {
        throw new Error('Unsupported field type definition');
      }
    } catch (error) {
      field.reasons.push(error instanceof Error ? error.message : 'Unresolved field');
    }
    return field;
  });

  if (new Set(fields.map((field) => `${field.namespace}|${field.name}`)).size !== fields.length) {
    throw new Error('Ambiguous feature field declarations');
  }
  const namespaces: Record<string, string> = Object.create(null);
  for (const attribute of root.attributes) {
    if (attribute.prefix === 'xmlns') namespaces[attribute.localName] = attribute.value;
  }
  return { featureType: typeof featureType === 'string' ? featureType : `{${featureNamespace}}${featureName}`, fields, issues, namespaces };
}
