import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { FeatureAttributeFormComponent } from './feature-attribute-form.component';
import { AttributeFormField } from '../../../utils/feature-attribute-draft';

function field(overrides: Partial<AttributeFormField> = {}): AttributeFormField {
  return { name: 'label', value: 'old', present: true, editable: true, reasons: [], schema: {
    name: 'label', namespace: '', type: 'string', minOccurs: '1', maxOccurs: '1',
    nillable: false, defaultValue: null, fixedValue: null, facets: [], reasons: []
  }, ...overrides };
}

describe('FeatureAttributeFormComponent', () => {
  let fixture: ComponentFixture<FeatureAttributeFormComponent>;
  let component: FeatureAttributeFormComponent;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [FeatureAttributeFormComponent, TranslateModule.forRoot()] }).compileComponents();
    fixture = TestBed.createComponent(FeatureAttributeFormComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('state', 'ready');
    fixture.componentRef.setInput('fields', [field()]);
    fixture.detectChanges();
  });
  afterEach(() => fixture.destroy());

  it('keeps a detached draft, and returning to the normalized base clears dirty', () => {
    const emit = jest.spyOn(component.dirtyChanged, 'emit');
    component.rows[0].group.controls.text.setValue('changed');
    expect(component.fields[0].value).toBe('old');
    expect(emit).toHaveBeenLastCalledWith(true);
    component.rows[0].group.controls.text.setValue('old');
    expect(component.dirty).toBe(false);
  });

  it('enables Apply and emits a valid draft without a global write gate', () => {
    const apply = jest.spyOn(component.apply, 'emit');
    component.rows[0].group.controls.text.setValue('new');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(false);
    component.submit(new Event('submit'));
    expect(apply).toHaveBeenCalledWith(new Map([['label', { presence: 'value', text: 'new' }]]));
  });

  it('renders enabled, labelled draft controls without mutating the feature', () => {
    const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea.attribute-value');
    expect(input.value).toBe('old');
    expect(input.disabled).toBe(false);
    expect(fixture.nativeElement.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    input.value = 'typed draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(component.dirty).toBe(true);
    expect(component.fields[0].value).toBe('old');
    expect(fixture.nativeElement.querySelector('.attribute-actions')).not.toBeNull();
  });

  it('represents multiline text in an editable textarea without mutating the feature value', () => {
    fixture.componentRef.setInput('fields', [field({ value: 'First\nSecond' })]);
    fixture.detectChanges();
    const input: HTMLTextAreaElement = fixture.nativeElement.querySelector('textarea.attribute-value');
    expect(input.value).toBe('First\nSecond');
    input.value = 'First\nChanged';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(component.fields[0].value).toBe('First\nSecond');
    expect(component.rows[0].group.controls.text.value).toBe('First\nChanged');
  });

  it('blocks controls and direct submit while the native transaction is running', () => {
    component.rows[0].group.controls.text.setValue('draft');
    fixture.componentRef.setInput('syncing', true);
    fixture.detectChanges();
    const apply = jest.spyOn(component.apply, 'emit');
    component.submit(new Event('submit'));
    expect(apply).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('fieldset').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBe(true);
    expect(component.rows[0].group.controls.text.value).toBe('draft');
  });

  it('emits typed inputs, not feature mutations, only on Apply', () => {
    fixture.detectChanges();
    const apply = jest.spyOn(component.apply, 'emit');
    component.rows[0].group.controls.text.setValue('new');
    component.submit(new Event('submit'));
    expect(apply).toHaveBeenCalledWith(new Map([['label', { presence: 'value', text: 'new' }]]));
    expect(component.fields[0].value).toBe('old');
  });

  it('preserves values during busy/error updates and resets only after an acknowledged new base', () => {
    component.rows[0].group.controls.text.setValue('draft');
    fixture.componentRef.setInput('busy', true);
    fixture.componentRef.setInput('error', 'registrationFailed');
    fixture.detectChanges();
    expect(component.rows[0].group.controls.text.value).toBe('draft');
    expect(component.dirty).toBe(true);
    fixture.componentRef.setInput('fields', [field({ value: 'draft' })]);
    fixture.detectChanges();
    expect(component.dirty).toBe(false);
  });

  it('validates and focuses the first invalid field without emitting Apply', async () => {
    const definition = field();
    definition.schema = { ...definition.schema!, type: 'int' };
    fixture.componentRef.setInput('fields', [definition]);
    fixture.detectChanges();
    component.rows[0].group.controls.text.setValue('');
    const apply = jest.spyOn(component.apply, 'emit');
    document.body.append(fixture.nativeElement);
    component.submit(new Event('submit'));
    fixture.detectChanges();
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    expect(component.rows[0].error).toBe('invalidValue');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('input'));
    fixture.nativeElement.remove();
  });

  it('renders unsupported HTML values as text and emits Cancel without applying', () => {
    fixture.componentRef.setInput('fields', [field({ editable: false, value: '<img src=x onerror=alert(1)>' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    const apply = jest.spyOn(component.apply, 'emit');
    const cancel = jest.spyOn(component.cancel, 'emit');
    fixture.nativeElement.querySelector('button[type="button"]').click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('prepares defaults only in a detached draft, keeping original absence', () => {
    fixture.componentRef.setInput('fields', [field({ value: undefined, present: false,
      initialInput: { presence: 'value', text: 'default' } })]);
    fixture.detectChanges();
    expect(component.rows[0].group.controls.text.value).toBe('default');
    expect(component.fields[0].present).toBe(false);
    expect(component.fields[0].value).toBeUndefined();
    expect(component.dirty).toBe(true);
  });

  it('normalizes numeric/boolean enumeration options without turning values into labels', () => {
    const definition = field({ value: 1 });
    definition.schema = { ...definition.schema!, type: 'int', facets: [{ name: 'enumeration', value: '01' }] };
    fixture.componentRef.setInput('fields', [definition]);
    fixture.detectChanges();
    expect(component.options(definition)).toEqual(['1']);
    expect(component.rows[0].group.controls.text.value).toBe('1');
    expect(component.dirty).toBe(false);
  });

  it('keeps lexical integers clean until their XSD value changes', () => {
    const definition = field({ value: '007' });
    definition.schema = { ...definition.schema!, type: 'int' };
    fixture.componentRef.setInput('fields', [definition]);
    fixture.detectChanges();
    expect(component.dirty).toBe(false);
    component.rows[0].group.controls.text.setValue('8');
    expect(component.dirty).toBe(true);
    component.rows[0].group.controls.text.setValue('7');
    expect(component.dirty).toBe(false);
    expect(component.fields[0].value).toBe('007');
  });

  it('selects the canonical boolean option while retaining the original GML lexeme', () => {
    const definition = field({ value: '1' });
    definition.schema = { ...definition.schema!, type: 'boolean' };
    fixture.componentRef.setInput('fields', [definition]);
    fixture.detectChanges();
    expect(component.rows[0].group.controls.text.value).toBe('true');
    expect(component.fields[0].value).toBe('1');
    expect(component.dirty).toBe(false);
  });

  it('focuses the invalid presence control independently of translated labels', () => {
    fixture.detectChanges();
    document.body.append(fixture.nativeElement);
    component.rows[0].group.controls.presence.setValue('absent');
    component.submit(new Event('submit'));
    expect(component.rows[0].error).toBe('required');
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('#attribute-presence-0'));
    fixture.nativeElement.remove();
  });

  it('shows local labels but emits the original qualified keys, including with colliding local names', () => {
    fixture.componentRef.setInput('fields', [field({ name: 'menorca:name' }), field({ name: 'other:name' })]);
    fixture.detectChanges();
    expect(Array.from(fixture.nativeElement.querySelectorAll('label')).map((label: any) => label.textContent.trim()))
      .toEqual(['name *', 'name *']);
    const emit = jest.spyOn(component.apply, 'emit');
    component.rows[0].group.controls.text.setValue('changed');
    component.submit(new Event('submit'));
    expect(emit.mock.calls[0][0]!.get('menorca:name')?.text).toBe('changed');
    expect(emit.mock.calls[0][0]!.has('name')).toBe(false);
    expect(emit.mock.calls[0][0]!.has('other:name')).toBe(true);
  });

  it('offers a JSON editor for structures, keeps deep-equivalent values clean and rejects invalid JSON', () => {
    const definition = field({ value: { items: ['a', 0, false] } });
    definition.schema = { ...definition.schema!, type: 'complex' };
    fixture.componentRef.setInput('fields', [definition]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('textarea.attribute-value').placeholder).toBe('JSON');
    expect(component.dirty).toBe(false);
    component.rows[0].group.controls.text.setValue('{"items":["a",0,false]}');
    expect(component.dirty).toBe(false);
    component.rows[0].group.controls.text.setValue('invalid JSON');
    const emit = jest.spyOn(component.apply, 'emit');
    component.submit(new Event('submit'));
    expect(component.rows[0].error).toBe('invalidValue');
    expect(emit).not.toHaveBeenCalled();
    component.rows[0].group.controls.text.setValue('{"items":["b",0,false]}');
    component.submit(new Event('submit'));
    expect(emit).toHaveBeenCalledTimes(1);
    expect(definition.value).toEqual({ items: ['a', 0, false] });
  });
});
