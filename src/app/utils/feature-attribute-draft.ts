import type { WfsAttributeField } from './wfs-attribute-schema';

export type AttributeData = Record<string, unknown>;
export type AttributePresence = 'absent' | 'null' | 'value';
export interface AttributeInput {
  presence: AttributePresence;
  text: string;
}
export interface AttributeFormField {
  name: string;
  schema: WfsAttributeField | null;
  value: unknown;
  present: boolean;
  editable: boolean;
  reasons: string[];
  initialInput?: AttributeInput;
}

/** Includes untouched values: the shared native history still makes a JSON copy. */
export function assertAttributeDataSafe(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
    throw new Error('unsafeData');
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('unsafeData');
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    throw new Error('unsafeData');
  }
  if (array && (Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index)))) {
    throw new Error('unsafeData');
  }
  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) ||
          ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) {
        throw new Error('unsafeData');
      }
      assertAttributeDataSafe(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function copyAttributeData(data: AttributeData): AttributeData {
  assertAttributeDataSafe(data);
  return JSON.parse(JSON.stringify(data)) as AttributeData;
}

export function fieldUsesJson(field: WfsAttributeField): boolean {
  return field.type === 'complex' || field.type === 'list' || field.maxOccurs !== '1';
}

export function attributeInput(value: unknown, present: boolean, field?: WfsAttributeField): AttributeInput {
  if (field && fieldUsesJson(field) && value != null) {
    if (field.type === 'list' && typeof value === 'string') value = value.trim() ? value.trim().split(/\s+/) : [];
    else if (field.maxOccurs !== '1' && !Array.isArray(value)) value = [value];
  }
  return {
    presence: !present ? 'absent' : value === null ? 'null' : 'value',
    text: value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
  };
}

const INTEGER_TYPES = new Set(['integer', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger',
  'nonPositiveInteger', 'negativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte']);
const INTEGER_BOUNDS: Record<string, [bigint, bigint]> = {
  long: [-9223372036854775808n, 9223372036854775807n], short: [-32768n, 32767n], byte: [-128n, 127n],
  unsignedLong: [0n, 18446744073709551615n], unsignedInt: [0n, 4294967295n], unsignedShort: [0n, 65535n], unsignedByte: [0n, 255n]
};

/** Exact numeric comparison, without rounding large integers/decimals via Number. */
function numericKey(text: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match || !(match[2] || match[3])) return text;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(match[4] ?? '0') - BigInt(match[3]?.length ?? 0);
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++; }
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

function compareNumeric(left: string, right: string): number {
  const a = numericKey(left), b = numericKey(right);
  if (a === b) return 0;
  const parts = (key: string): { negative: boolean; digits: string; size: bigint } => {
    if (key === '0') return { negative: false, digits: '0', size: 0n };
    const match = /^(-?)(\d+)e(-?\d+)$/.exec(key);
    if (!match) throw new Error('invalidValue');
    return { negative: !!match[1], digits: match[2], size: BigInt(match[2].length) + BigInt(match[3]) };
  };
  const x = parts(a), y = parts(b);
  if (x.negative !== y.negative) return x.negative ? -1 : 1;
  const sign = x.negative ? -1 : 1;
  if (x.digits === '0') return -sign;
  if (y.digits === '0') return sign;
  if (x.size !== y.size) return x.size < y.size ? -sign : sign;
  const length = Math.max(x.digits.length, y.digits.length);
  return x.digits.padEnd(length, '0') < y.digits.padEnd(length, '0') ? -sign : sign;
}

function parseJsonInput(text: string): unknown {
  // JSON.parse must not round a user's numeric literal before safety validation.
  // Quote precision-sensitive values in JSON, just as in lexical scalar inputs.
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (!token.startsWith('"') && numericKey(token) !== numericKey(String(Number(token)))) throw new Error('invalidValue');
  }
  const value: unknown = JSON.parse(text);
  assertAttributeDataSafe(value);
  return value;
}

function scalar(field: WfsAttributeField, text: string): string | number | boolean {
  if (!/^[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u.test(text)) throw new Error('invalidValue');
  const normalized = text.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (field.type === 'boolean') {
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    throw new Error('invalidValue');
  }
  if (field.type === 'int' && /^[+-]?\d+$/.test(normalized)) {
    const value = Number(normalized);
    if (Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647 &&
         !Object.is(value, -0)) return value;
  }
  if (field.type === 'int') throw new Error('invalidValue');
  if (INTEGER_TYPES.has(field.type ?? '')) {
    if (!/^[+-]?\d+$/.test(normalized)) throw new Error('invalidValue');
    const value = BigInt(normalized);
    const bounds = INTEGER_BOUNDS[field.type!];
    if (bounds && (value < bounds[0] || value > bounds[1]) ||
        field.type === 'nonNegativeInteger' && value < 0n || field.type === 'positiveInteger' && value <= 0n ||
        field.type === 'nonPositiveInteger' && value > 0n || field.type === 'negativeInteger' && value >= 0n) throw new Error('invalidValue');
    return normalized;
  }
  if (field.type === 'decimal' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) throw new Error('invalidValue');
  if (['float', 'double'].includes(field.type ?? '') &&
      !/^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|-?INF|NaN)$/.test(normalized)) throw new Error('invalidValue');
  // Dates, binary lexical values, unions and application-specific simple types
  // stay lexical. Their complete XSD validation belongs to the WFS service.
  return text;
}

/** Editability is not a whitelist of types or a per-field permission policy. */
export function fieldValidationSupported(field: WfsAttributeField): boolean {
  return !['__proto__', 'constructor', 'prototype', 'toJSON'].includes(field.name) &&
    /^[\p{L}_][\p{L}\p{N}_.\-\u00B7]*$/u.test(field.name) &&
    /^\d+$/.test(field.minOccurs) && /^(\d+|unbounded)$/.test(field.maxOccurs);
}

/** undefined denotes absence, never null, empty text, false or zero. */
export function parseAttributeInput(field: WfsAttributeField, input: AttributeInput): unknown {
  if (!fieldValidationSupported(field)) throw new Error('unverified');
  if (input.presence === 'absent') {
    if (field.minOccurs !== '0') throw new Error('required');
    return undefined;
  }
  if (input.presence === 'null') {
    if (!field.nillable) throw new Error('notNullable');
    return null;
  }
  let value: unknown;
  if (fieldUsesJson(field)) {
    try { value = parseJsonInput(input.text); }
    catch { throw new Error('invalidValue'); }
    if (field.type === 'list' || field.maxOccurs !== '1') {
      if (!Array.isArray(value)) throw new Error('invalidValue');
      if (field.maxOccurs !== '1' && (value.length < Number(field.minOccurs) ||
          field.maxOccurs !== 'unbounded' && value.length > Number(field.maxOccurs))) throw new Error('restriction');
      const item = { ...field, type: field.type === 'list' ? field.itemType ?? 'string' : field.type,
        maxOccurs: '1', facets: [] };
      value = value.map((entry: unknown) => {
        if (item.type === 'complex') { assertAttributeDataSafe(entry); return entry; }
        if (entry === null && field.type !== 'list' && field.nillable) return null;
        if (!['string', 'number', 'boolean'].includes(typeof entry)) throw new Error('invalidValue');
        return scalar(item, String(entry));
      });
    } else if (!value || typeof value !== 'object') throw new Error('invalidValue');
  } else value = scalar(field, input.text);
  if (field.fixedValue !== null && !attributeValuesEqual({ ...field, fixedValue: null }, value,
      parseAttributeInput({ ...field, fixedValue: null }, attributeInput(field.fixedValue, true, field)))) throw new Error('restriction');
  const enumerations = field.facets.filter((facet) => facet.name === 'enumeration');
  if (enumerations.length && !enumerations.some((facet) => fieldUsesJson(field)
    ? attributeValuesEqual({ ...field, facets: [] }, value, facet.value)
    : scalarEqual(field, scalar(field, facet.value), value))) {
    throw new Error('enumeration');
  }
  // XSD string length counts Unicode code points, not UTF-16 code units.
  const length = Array.isArray(value) ? value.length : typeof value === 'string' ? [...value].length : 0;
  for (const facet of field.facets) {
    const limit = Number(facet.value);
    const numericFacet = ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'].includes(facet.name) &&
      (field.type === 'int' || INTEGER_TYPES.has(field.type ?? '') || ['decimal', 'float', 'double'].includes(field.type ?? ''));
    const comparison = numericFacet ? compareNumeric(String(value), facet.value) : 0;
    const numeric = numericKey(String(value));
    const digits = /^-?(\d+)e(-?\d+)$/.exec(numeric);
    if ((facet.name === 'length' && length !== limit) ||
        (facet.name === 'minLength' && length < limit) ||
        (facet.name === 'maxLength' && length > limit) ||
        (numericFacet && facet.name === 'minInclusive' && comparison < 0) ||
        (numericFacet && facet.name === 'maxInclusive' && comparison > 0) ||
        (numericFacet && facet.name === 'minExclusive' && comparison <= 0) ||
        (numericFacet && facet.name === 'maxExclusive' && comparison >= 0) ||
        (facet.name === 'totalDigits' && digits && BigInt(digits[1].length) +
          (BigInt(digits[2]) > 0n ? BigInt(digits[2]) : 0n) > BigInt(facet.value)) ||
        (facet.name === 'fractionDigits' && digits && -BigInt(digits[2]) > BigInt(facet.value))) {
      throw new Error('restriction');
    }
  }
  return value;
}

/** Compare XSD values without rewriting the representation received from WFS. */
export function attributeValuesEqual(field: WfsAttributeField, left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null) return false;
  try { return scalarEqual(field, attributeScalarValue(field, left), attributeScalarValue(field, right)); }
  catch { return false; }
}

export function attributeScalarValue(field: WfsAttributeField, value: unknown): unknown {
  if (!fieldUsesJson(field) && (!['string', 'number', 'boolean'].includes(typeof value) || Object.is(value, -0))) throw new Error('invalidValue');
  return parseAttributeInput(field, attributeInput(value, true, field));
}

function scalarEqual(field: WfsAttributeField, left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' && typeof right !== 'object' &&
      (field.type === 'int' || INTEGER_TYPES.has(field.type ?? '') || ['decimal', 'float', 'double'].includes(field.type ?? ''))) {
    return numericKey(String(left)) === numericKey(String(right));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) &&
    scalarEqual({ ...field, type: field.type === 'list' ? field.itemType ?? 'string' : field.maxOccurs !== '1' ? field.type : null, maxOccurs: '1' },
      (left as AttributeData)[key], (right as AttributeData)[key]));
}

export interface AttributeMerge {
  data: AttributeData;
  delta: AttributeData;
  conflicts: string[];
}

/** Three-way merge. Only touched, form-mapped fields can enter the native history. */
export function mergeAttributeDraft(
  base: AttributeData,
  current: AttributeData,
  inputs: ReadonlyMap<string, AttributeInput>,
  fields: readonly AttributeFormField[]
): AttributeMerge {
  const data = copyAttributeData(current);
  const delta: AttributeData = {};
  const conflicts: string[] = [];
  for (const [name, input] of inputs) {
    const field = fields.find((item) => item.name === name);
    if (!field?.editable || !field.schema) throw new Error('unverified');
    const proposed = parseAttributeInput(field.schema, input);
    const present = proposed !== undefined;
    const basePresent = Object.hasOwn(base, name);
    if (present === basePresent && (!present || attributeValuesEqual(field.schema, proposed, base[name]))) continue;
    // Removing an existing property is not a verified WFS Update operation.
    if (!present) throw new Error('unverified');
    const currentPresent = Object.hasOwn(current, name);
    if ((currentPresent !== basePresent || !attributeValuesEqual(field.schema, current[name], base[name])) &&
        (!currentPresent || !attributeValuesEqual(field.schema, current[name], proposed))) {
      conflicts.push(name);
      continue;
    }
    if (!currentPresent || !attributeValuesEqual(field.schema, current[name], proposed)) {
      // GML readers can return lexical numeric/boolean values; JSON readers return
      // primitives. Preserve that contract for existing properties and untouched data.
      // Structured values must never pass through String(array/object).
      let value = typeof current[name] === 'string' && proposed !== null && typeof proposed !== 'object' ? String(proposed) : proposed;
      if (typeof current[name] === 'number' && typeof proposed === 'string' &&
          Number.isFinite(Number(proposed)) && !Object.is(Number(proposed), -0) &&
          (!Number.isInteger(Number(proposed)) || Number.isSafeInteger(Number(proposed))) &&
          numericKey(proposed) === numericKey(String(Number(proposed)))) value = Number(proposed);
      delta[name] = value;
      data[name] = value;
    }
  }
  return { data, delta, conflicts };
}
