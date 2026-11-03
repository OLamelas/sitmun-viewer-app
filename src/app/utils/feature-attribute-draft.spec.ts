import {
  AttributeFormField, assertAttributeDataSafe, attributeInput, fieldValidationSupported,
  mergeAttributeDraft, parseAttributeInput
} from './feature-attribute-draft';
import { WfsAttributeField } from './wfs-attribute-schema';

const schema = (overrides: Partial<WfsAttributeField> = {}): WfsAttributeField => ({
  name: 'label', namespace: '', type: 'string', minOccurs: '0', maxOccurs: '1',
  nillable: true, defaultValue: null, fixedValue: null, facets: [], reasons: [], ...overrides
});
const field = (value: unknown, overrides: Partial<WfsAttributeField> = {}): AttributeFormField => ({
  name: 'label', schema: schema(overrides), value, present: value !== undefined, editable: true, reasons: []
});

describe('attribute draft validation and three-way merge', () => {
  it('distinguishes absent, null, false, zero and empty string', () => {
    expect(attributeInput(undefined, false)).toEqual({ presence: 'absent', text: '' });
    expect(parseAttributeInput(schema(), { presence: 'value', text: '' })).toBe('');
    expect(parseAttributeInput(schema(), { presence: 'null', text: '' })).toBeNull();
    expect(parseAttributeInput(schema(), { presence: 'absent', text: '' })).toBeUndefined();
    expect(parseAttributeInput(schema({ type: 'boolean' }), { presence: 'value', text: '0' })).toBe(false);
    expect(parseAttributeInput(schema({ type: 'int' }), { presence: 'value', text: '0' })).toBe(0);
  });

  it.each(['', '1.2', 'NaN', '2147483648', '-2147483649', '-0'])('rejects invalid int %j without coercion', (text) => {
    expect(() => parseAttributeInput(schema({ type: 'int' }), { presence: 'value', text })).toThrow();
  });

  it('validates required presence without treating empty XSD string as absent', () => {
    const required = schema({ minOccurs: '1', nillable: false });
    expect(() => parseAttributeInput(required, { presence: 'absent', text: '' })).toThrow('required');
    expect(() => parseAttributeInput(required, { presence: 'null', text: '' })).toThrow('notNullable');
    expect(parseAttributeInput(required, { presence: 'value', text: '' })).toBe('');
  });

  it('validates Unicode length, enum types and bounds', () => {
    expect(parseAttributeInput(schema({ facets: [{ name: 'length', value: '1' }] }),
      { presence: 'value', text: '😀' })).toBe('😀');
    const numeric = schema({ type: 'int', facets: [
      { name: 'enumeration', value: '01' }, { name: 'maxInclusive', value: '2' }
    ] });
    expect(parseAttributeInput(numeric, { presence: 'value', text: '1' })).toBe(1);
    expect(() => parseAttributeInput(numeric, { presence: 'value', text: '2' })).toThrow('enumeration');
    expect(fieldValidationSupported(schema({ facets: [{ name: 'pattern', value: '.*' }] }))).toBe(true);
    expect(fieldValidationSupported(schema({ fixedValue: 'fixed' }))).toBe(true);
    expect(fieldValidationSupported(schema({ type: 'dateTime' }))).toBe(true);
  });

  it('does not mutate base/current, keeps untouched external changes and reports same-field conflicts', () => {
    const base = { label: 'old', untouched: false };
    const current = { label: 'old', untouched: true };
    const inputs = new Map([['label', { presence: 'value' as const, text: 'new' }]]);
    expect(mergeAttributeDraft(base, current, inputs, [field('old')])).toEqual({
      data: { label: 'new', untouched: true }, delta: { label: 'new' }, conflicts: []
    });
    expect(current.label).toBe('old');
    expect(mergeAttributeDraft(base, { label: 'external' }, inputs, [field('old')]).conflicts).toEqual(['label']);
    expect(mergeAttributeDraft(base, { label: 'new' }, inputs, [field('old')]).delta).toEqual({});
    expect(mergeAttributeDraft(base, current, new Map([['label', { presence: 'value', text: 'old' }]]),
      [field('old')]).delta).toEqual({});
  });

  it('rejects undeclared changes and deletion of existing properties', () => {
    expect(() => mergeAttributeDraft({}, {}, new Map([['html', { presence: 'value', text: '<b>x</b>' }]]), [])).toThrow();
    expect(() => mergeAttributeDraft({ label: 'old' }, { label: 'old' },
      new Map([['label', { presence: 'absent', text: '' }]]), [field('old')])).toThrow();
  });

  it('keeps untouched numeric lexemes and uses the original representation for changed values', () => {
    const numeric = field('007', { type: 'int' });
    const base = { label: '007', untouched: '01' };
    const unchanged = new Map([['label', { presence: 'value' as const, text: '7' }]]);
    expect(mergeAttributeDraft(base, base, unchanged, [numeric])).toEqual({ data: base, delta: {}, conflicts: [] });
    const changed = new Map([['label', { presence: 'value' as const, text: '8' }]]);
    expect(mergeAttributeDraft(base, base, changed, [numeric]).data).toEqual({ label: '8', untouched: '01' });
    expect(mergeAttributeDraft({ label: 7 }, { label: 7 }, changed, [field(7, { type: 'int' })]).data).toEqual({ label: 8 });
    expect(mergeAttributeDraft(base, { ...base, label: '9' }, changed, [numeric]).conflicts).toEqual(['label']);
  });

  it('does not mark an equivalent boolean lexeme as an edit', () => {
    const boolean = field('1', { type: 'boolean' });
    expect(mergeAttributeDraft({ label: '1' }, { label: 'true' },
      new Map([['label', { presence: 'value', text: 'true' }]]), [boolean]).delta).toEqual({});
  });

  it.each([
    ['date', '2026-11-02'], ['time', '12:30:00.123+02:00'], ['dateTime', '2026-11-02T12:30:00.123-03:00'],
    ['decimal', '12345678901234567890.123456789'], ['long', '9223372036854775807'],
    ['integer', '123456789012345678901234567890'], ['double', '1.234e100'], ['float', 'INF'],
    ['base64Binary', 'AAE='], ['hexBinary', '00FF'], ['anyURI', 'https://example.test/a'], ['union', 'custom']
  ])('allows %s as a lossless lexical value', (type, text) => {
    expect(parseAttributeInput(schema({ type }), { presence: 'value', text })).toBe(text);
  });

  it('compares numeric facets without rounding and preserves numbers or exact text on merge', () => {
    const decimal = schema({ type: 'decimal', facets: [{ name: 'maxInclusive', value: '1.0000000000000000001' }] });
    expect(() => parseAttributeInput(decimal, { presence: 'value', text: '1.0000000000000000002' })).toThrow('restriction');
    const inputs = new Map([['label', { presence: 'value' as const, text: '1.0000000000000000001' }]]);
    expect(mergeAttributeDraft({ label: 1 }, { label: 1 }, inputs, [field(1, { type: 'decimal' })]).data['label'])
      .toBe('1.0000000000000000001');
    expect(mergeAttributeDraft({ label: '01.00' }, { label: '1' },
      new Map([['label', { presence: 'value', text: '1.0' }]]), [field('01.00', { type: 'decimal' })]).delta).toEqual({});
  });

  it('edits lists and repeated fields as JSON while retaining their distinct XSD contracts', () => {
    const list = schema({ type: 'list', itemType: 'int' });
    expect(attributeInput('1  2', true, list).text).toBe('[\n  "1",\n  "2"\n]');
    expect(parseAttributeInput(list, { presence: 'value', text: '[1, "2"]' })).toEqual([1, 2]);
    expect(parseAttributeInput(schema({ type: 'string', maxOccurs: 'unbounded' }),
      { presence: 'value', text: '["a", "b"]' })).toEqual(['a', 'b']);
    expect(() => parseAttributeInput(list, { presence: 'value', text: '[null]' })).toThrow();
  });

  it('keeps complex drafts clean across deep copies and detects genuine concurrent changes', () => {
    const complex = field({ items: ['a', false, 0] }, { type: 'complex' });
    const base = { label: { items: ['a', false, 0] } };
    const unchanged = new Map([['label', { presence: 'value' as const, text: '{"items":["a",false,0]}' }]]);
    expect(mergeAttributeDraft(base, JSON.parse(JSON.stringify(base)), unchanged, [complex]).delta).toEqual({});
    const changed = new Map([['label', { presence: 'value' as const, text: '{"items":["b",false,0]}' }]]);
    expect(mergeAttributeDraft(base, base, changed, [complex]).data['label']).toEqual({ items: ['b', false, 0] });
    expect(mergeAttributeDraft(base, { label: { items: ['external'] } }, changed, [complex]).conflicts).toEqual(['label']);
    for (const text of ['{"n":1.0000000000000000001}', '{"__proto__":{}}', 'invalid']) {
      expect(() => parseAttributeInput(complex.schema!, { presence: 'value', text })).toThrow('invalidValue');
    }
  });

  it.each([undefined, NaN, Infinity, -0, 9007199254740992, new Date(), BigInt(1), [, 'x']])(
    'blocks an unsafe untouched value %p', (value) => {
      expect(() => assertAttributeDataSafe({ label: 'old', untouched: value })).toThrow('unsafeData');
    }
  );

  it('rejects accessors without executing them, cycles and custom serialization', () => {
    const get = jest.fn();
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get });
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    for (const value of [accessor, cycle, { toJSON: () => 'changed' }, { [Symbol()]: 1 }]) {
      expect(() => assertAttributeDataSafe(value)).toThrow();
    }
    expect(get).not.toHaveBeenCalled();
  });
});
