import { assertAttributeDataSafe } from './feature-attribute-draft';
import { WfsAttributeField, WfsAttributeSchema } from './wfs-attribute-schema';

interface NativeTransactionFeature {
  getKeys(): string[];
  get(name: string): unknown;
  getGeometryName(): string;
}

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XML = 'http://www.w3.org/XML/1998/namespace';
const xmlName = /^[\p{L}_][\p{L}\p{N}_.\-\u00B7]*(?::[\p{L}_][\p{L}\p{N}_.\-\u00B7]*)?$/u;

function namespaceFor(name: string, schema: WfsAttributeSchema, fallback: string): string {
  if (!xmlName.test(name)) throw new Error('invalidValue');
  if (!name.includes(':')) return fallback;
  const prefix = name.split(':')[0];
  const namespace = prefix === 'xml' ? XML : prefix === 'xsi' ? XSI : schema.namespaces?.[prefix];
  if (!namespace) throw new Error('unverified');
  return namespace;
}

function definition(schema: WfsAttributeSchema, key: string): WfsAttributeField | undefined {
  const parts = key.split(':');
  const fields = schema.fields.filter((field) => field.name === parts.at(-1) &&
    (parts.length === 1 || schema.namespaces?.[parts[0]] === field.namespace));
  return fields.length === 1 ? fields[0] : undefined;
}

/** Validate the native JSON-to-XML shape before it can enter shared history. */
export function assertWfsAttributeValue(value: unknown, schema: WfsAttributeSchema): void {
  assertAttributeDataSafe(value);
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && !/^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u.test(item)) throw new Error('invalidValue');
    if (Array.isArray(item)) {
      if (item.some(Array.isArray)) throw new Error('invalidValue');
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (key !== '#text') namespaceFor(key.startsWith('@') ? key.slice(1) : key, schema, '');
      if ((key === '#text' || key.startsWith('@')) && child !== null && typeof child === 'object') throw new Error('invalidValue');
      visit(child);
    }
  };
  visit(value);
}

function appendElement(parent: Element, name: string, value: unknown, schema: WfsAttributeSchema, namespace: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => appendElement(parent, name, item, schema, namespace));
    return;
  }
  const ns = namespaceFor(name, schema, namespace);
  const node = parent.ownerDocument.createElementNS(ns || null, name);
  parent.appendChild(node);
  appendValue(node, value, schema, ns);
}

function appendValue(node: Element, value: unknown, schema: WfsAttributeSchema, namespace: string): void {
  if (value === null) {
    node.setAttributeNS(XMLNS, 'xmlns:xsi', XSI);
    node.setAttributeNS(XSI, 'xsi:nil', 'true');
  } else if (typeof value === 'object' && value && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === '#text') {
        if (child === null) appendValue(node, null, schema, namespace);
        else node.appendChild(node.ownerDocument.createTextNode(String(child)));
      } else if (key.startsWith('@')) {
        const name = key.slice(1);
        const ns = namespaceFor(name, schema, '');
        node.setAttributeNS(ns || null, name, child === null ? '' : String(child));
      } else appendElement(node, key, child, schema, namespace);
    }
  } else {
    if (Array.isArray(value)) throw new Error('invalidValue');
    node.appendChild(node.ownerDocument.createTextNode(String(value)));
  }
}

function rewriteInsert(node: Element, feature: NativeTransactionFeature, schema: WfsAttributeSchema, featureNamespace: string): void {
  const keys = feature.getKeys();
  const rank = (key: string): number => {
    const field = definition(schema, key);
    return field ? schema.fields.indexOf(field) : schema.fields.length;
  };
  // OpenLayers initially writes every property in the feature namespace, even
  // unqualified fields, and omits nulls. Rebuild attributes in XSD order instead
  // of matching by the desired namespace and leaving the native node behind.
  const original = Array.from(node.children);
  const staging = node.ownerDocument.createElement('staging');
  for (const key of keys.sort((left, right) => rank(left) - rank(right))) {
    const value = feature.get(key);
    if (key === 'gml:boundedBy' || value === undefined) continue;
    if (key === feature.getGeometryName() || value !== null &&
        typeof (value as { getSimplifiedGeometry?: unknown }).getSimplifiedGeometry === 'function') {
      // Move the native geometry element intact: no coordinate/CRS conversion.
      for (const geometry of original.filter((child) => child.tagName === key)) staging.appendChild(geometry);
      continue;
    }
    const field = definition(schema, key);
    assertWfsAttributeValue(value, schema);
    const namespace = namespaceFor(key, schema, field?.namespace ?? featureNamespace);
    const normalized = field?.type === 'list' && Array.isArray(value) ? value.join(' ') : value;
    appendElement(staging, key, normalized, schema, namespace);
  }
  node.replaceChildren(...Array.from(staging.childNodes));
}

/** Repair only attribute values; native WFSEdit still owns geometry, IDs and HTTP. */
export function serializeWfsAttributeTransaction(
  transaction: Element,
  inserts: readonly NativeTransactionFeature[],
  updates: readonly NativeTransactionFeature[],
  schema: WfsAttributeSchema
): void {
  const wfs = transaction.namespaceURI!;
  const featureNamespace = schema.featureType.startsWith('{') ? schema.featureType.slice(1, schema.featureType.indexOf('}'))
    : schema.namespaces?.[schema.featureType.split(':')[0]] ?? '';
  const insertNodes = Array.from(transaction.children).filter((node) => node.localName === 'Insert').flatMap((node) => Array.from(node.children));
  const updateNodes = Array.from(transaction.children).filter((node) => node.localName === 'Update');
  if (insertNodes.length !== inserts.length || updateNodes.length !== updates.length) throw new Error('unverified');
  const rewriteUpdate = (node: Element, feature: NativeTransactionFeature): void => {
    for (const key of feature.getKeys()) {
      const value = feature.get(key);
      if (key === feature.getGeometryName() || key === 'gml:boundedBy' || value == null ||
          typeof (value as { getSimplifiedGeometry?: unknown }).getSimplifiedGeometry === 'function') continue;
      const field = definition(schema, key);
      if (typeof value !== 'object' && field?.type !== 'list') continue;
      assertWfsAttributeValue(value, schema);
      const namespace = namespaceFor(key, schema, field?.namespace ?? featureNamespace);
      const normalized = field?.type === 'list' && Array.isArray(value) ? value.join(' ') : value;
      const property = Array.from(node.children).find((child) => child.localName === 'Property' &&
        Array.from(child.children).some((item) => ['Name', 'ValueReference'].includes(item.localName) && item.textContent === key));
      if (!property) throw new Error('unverified');
      Array.from(property.children).filter((child) => child.localName === 'Value').forEach((child) => child.remove());
      const target = node.ownerDocument.createElementNS(wfs, 'Value');
      property.appendChild(target);
      if (Array.isArray(normalized)) normalized.forEach((item) => appendElement(target, key, item, schema, namespace));
      else appendValue(target, normalized, schema, namespace);
    }
  };
  inserts.forEach((feature, index) => rewriteInsert(insertNodes[index], feature, schema, featureNamespace));
  updates.forEach((feature, index) => rewriteUpdate(updateNodes[index], feature));
}
