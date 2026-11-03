import { AttributeData, AttributeFormField, attributeInput, fieldUsesJson, fieldValidationSupported } from './feature-attribute-draft';
import { WfsAttributeField, WfsAttributeSchema, WfsFeatureTypeIdentity } from './wfs-attribute-schema';

interface NativeAttribute {
  name: string;
  isId?: boolean;
  isGeometry?: boolean;
  originalType?: unknown;
  /** Internal evidence only; never written back to SITNA. */
  resolvedNamespace?: string;
}
export interface NativeAttributeMetadata {
  name?: string | string[];
  origin?: string;
  /** Spelling used by the installed SITNA metadata contract. */
  originaData?: Record<string, unknown>;
  attributes?: NativeAttribute[];
  geometries?: { name: string | string[] }[];
}

/** Qualify ambiguous native local names only from a verified WFS description. */
export function resolveNativeAttributeMetadata(
  schema: WfsAttributeSchema,
  metadata: NativeAttributeMetadata | null | undefined,
  identity: WfsFeatureTypeIdentity
): NativeAttributeMetadata | undefined {
  if (!metadata) return undefined;
  const names = Array.isArray(metadata.name) ? metadata.name : [metadata.name];
  const parts = typeof names[0] === 'string' ? names[0].split(':') : [];
  const sameType = names.length === 1 && parts.at(-1) === identity.localName &&
    (parts.length === 1 || parts.length === 2 && schema.namespaces?.[parts[0]] === identity.namespaceURI);
  const verified = metadata.origin === 'WFS' && sameType && schema.issues.length === 0 &&
    schema.featureType === `{${identity.namespaceURI}}${identity.localName}`;
  const builtInType = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const type = value.split(':');
    if (type.length === 1) return type[0];
    return type.length === 2 && schema.namespaces?.[type[0]] === 'http://www.w3.org/2001/XMLSchema'
      ? type[1] : undefined;
  };
  return {
    ...metadata,
    attributes: metadata.attributes?.map((attribute) => {
      // Do not trust a namespace supplied on the original metadata object.
      const copy: NativeAttribute = { ...attribute, resolvedNamespace: undefined };
      if (!verified || typeof attribute.name !== 'string' || attribute.name.includes(':') ||
          schema.fields.filter((field) => field.name === attribute.name).length < 2) return copy;
      const local = schema.fields.filter((field) => field.name === attribute.name &&
        field.namespace === identity.namespaceURI && field.inherited === false);
      if (local.length !== 1 || !metadata.originaData || !Object.hasOwn(metadata.originaData, attribute.name)) return copy;
      const geometries = (metadata.geometries ?? []).flatMap((item) => Array.isArray(item.name) ? item.name : [item.name]);
      if (geometries.some((name) => typeof name !== 'string' || name === attribute.name || matchesKey(schema, local[0], name)) ||
          [...(metadata.attributes ?? []).map((item) => item.name), ...geometries].some((name) => {
            if (typeof name !== 'string') return true;
            const parts = name.split(':');
            return parts.at(-1) === attribute.name && parts.length > 1 &&
              (parts.length !== 2 || !schema.namespaces?.[parts[0]]);
          })) return copy;
      const original = metadata.originaData[attribute.name];
      if (!original || typeof original !== 'object' || Array.isArray(original)) return copy;
      const declaration = original as Record<string, unknown>;
      const field = local[0];
      if (declaration['@name'] !== attribute.name || declaration['@ref'] !== undefined ||
          declaration['type'] !== attribute.originalType ||
          builtInType(attribute.originalType) !== field.type ||
          builtInType(declaration['@type']) !== field.type ||
          declaration['@form'] !== undefined && declaration['@form'] !== 'qualified' ||
          declaration['@minOccurs'] !== undefined && String(declaration['@minOccurs']) !== field.minOccurs ||
          declaration['@maxOccurs'] !== undefined && String(declaration['@maxOccurs']) !== field.maxOccurs ||
          declaration['@nillable'] !== undefined && declaration['@nillable'] !== field.nillable) return copy;
      copy.resolvedNamespace = field.namespace;
      return copy;
    })
  };
}

/** Local names are usable only when unique; explicit prefixes must resolve exactly. */
function matchesKey(schema: WfsAttributeSchema, field: WfsAttributeField, key: string): boolean {
  const parts = key.split(':');
  if (parts.length === 2) return parts[1] === field.name && schema.namespaces?.[parts[0]] === field.namespace;
  return parts.length === 1 && key === field.name && schema.fields.filter((item) => item.name === key).length === 1;
}

export function isHiddenGmlAttribute(schema: WfsAttributeSchema, name: string): boolean {
  return name.startsWith('gml:') || schema.fields.some((field) =>
    ['http://www.opengis.net/gml', 'http://www.opengis.net/gml/3.2'].includes(field.namespace) && matchesKey(schema, field, name));
}

export function attributeFormFields(
  schema: WfsAttributeSchema,
  data: AttributeData,
  metadata: NativeAttributeMetadata | undefined,
  schemaHasIssues: boolean,
  text: (key: string) => string,
  provisional = false
): AttributeFormField[] {
  const fields: AttributeFormField[] = [];
  const known = new Set<string>();
  for (const field of schema.fields) {
    if (['http://www.opengis.net/gml', 'http://www.opengis.net/gml/3.2'].includes(field.namespace)) continue;
    const dataKeys = Object.keys(data).filter((key) => matchesKey(schema, field, key));
    const attributes = (metadata?.attributes ?? []).filter((item) => typeof item.name === 'string' &&
      (item.resolvedNamespace !== undefined
        ? item.name === field.name && item.resolvedNamespace === field.namespace
        : matchesKey(schema, field, item.name)));
    const geometries = (metadata?.geometries ?? []).flatMap((item) => Array.isArray(item.name) ? item.name : [item.name]);
    const geometry = geometries.some((name) => matchesKey(schema, field, name));
    const dataKey = dataKeys.length === 1 ? dataKeys[0] : undefined;
    const native = attributes.length === 1 ? attributes[0] : undefined;
    // Coordinates live outside feature data and remain owned by the map tools.
    if (geometry || native?.isGeometry) { dataKeys.forEach((key) => known.add(key)); continue; }
    const reasons: string[] = [];
    if (schemaHasIssues) reasons.push(text('featureAttribute.schemaIncomplete'));
    if (!native && !geometry) reasons.push(text('featureAttribute.unverified'));
    if (dataKeys.length > 1 || attributes.length > 1 ||
        (native?.resolvedNamespace !== undefined && Object.hasOwn(data, field.name)) ||
        (schema.fields.filter((item) => item.name === field.name).length > 1 && !dataKey)) {
      reasons.push(text('featureAttribute.ambiguousField'));
    }
    if (!fieldValidationSupported(field)) reasons.push(text('featureAttribute.unsupportedField'));
    const value = dataKey === undefined ? undefined : data[dataKey];
    if (dataKey) known.add(dataKey);
    if (dataKeys.length > 1) {
      for (const key of dataKeys) {
        known.add(key);
        fields.push({ name: key, schema: null, value: data[key], present: true, editable: false,
          reasons: [text('featureAttribute.ambiguousField')] });
      }
      continue;
    }
    // Preserve the actual key. For a new property use the unique native name,
    // never guess that two different namespaces with the same local name coincide.
    const prefix = Object.keys(schema.namespaces ?? {}).find((key) => schema.namespaces?.[key] === field.namespace);
    const name = dataKey ?? (native?.resolvedNamespace === undefined ? native?.name : undefined) ??
      (prefix ? `${prefix}:${field.name}` : field.name);
    if (isHiddenGmlAttribute(schema, name)) continue;
    const formSchema = value !== null && typeof value === 'object' && !fieldUsesJson(field) ? { ...field, type: 'complex' } : field;
    fields.push({ name, schema: formSchema, value, present: dataKey !== undefined,
      editable: reasons.length === 0, reasons: [...new Set(reasons)],
      initialInput: dataKey === undefined && provisional && field.defaultValue !== null && !reasons.length
        ? attributeInput(field.defaultValue, true, field) : undefined });
  }
  for (const name of Object.keys(data)) {
    if (known.has(name) || isHiddenGmlAttribute(schema, name)) continue;
    const [prefix, local] = name.includes(':') ? name.split(':') : ['', name];
    const value = data[name];
    const fallback: WfsAttributeField = {
      name: local, namespace: schema.namespaces?.[prefix] ?? '',
      type: value !== null && typeof value === 'object' ? 'complex' : typeof value === 'boolean' ? 'boolean' : 'string',
      minOccurs: '0', maxOccurs: '1', nillable: true, defaultValue: null, fixedValue: null, facets: [], reasons: []
    };
    // Unknown prefixes/ambiguous local names are not a type restriction: their
    // destination cannot be determined safely, even with layer-level editing.
    const editable = !schemaHasIssues && fieldValidationSupported(fallback) && (!prefix || !!schema.namespaces?.[prefix]) &&
      !schema.fields.some((field) => field.name === name);
    fields.push({ name, schema: editable ? fallback : null, value, present: true, editable,
      reasons: editable ? [] : [text('featureAttribute.unknownField')] });
  }
  return fields;
}

/** Only the exact auxiliary bounds key already excluded by the native patch. */
export function isAuxiliaryGmlBounds(schema: WfsAttributeSchema, name: string, value: unknown): boolean {
  return name === 'gml:boundedBy' && schema.namespaces?.['gml'] === 'http://www.opengis.net/gml/3.2' &&
    Array.isArray(value) && [4, 6].includes(value.length) && value.every((number) => typeof number === 'number' && Number.isFinite(number));
}
