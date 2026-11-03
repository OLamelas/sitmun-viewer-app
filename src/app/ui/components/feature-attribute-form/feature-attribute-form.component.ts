import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input,
  OnChanges, OnDestroy, Output, inject
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import {
  AttributeFormField, AttributeInput, AttributePresence, attributeInput,
  parseAttributeInput, attributeValuesEqual, attributeScalarValue, fieldUsesJson
} from '../../../utils/feature-attribute-draft';

type AttributeControls = {
  presence: FormControl<AttributePresence>;
  text: FormControl<string>;
};
interface FieldRow {
  field: AttributeFormField;
  group: FormGroup<AttributeControls>;
  initial: AttributeInput;
  error: string;
}

@Component({
  selector: 'app-feature-attribute-form',
  standalone: true,
  imports: [ReactiveFormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="attribute-editor" [attr.aria-busy]="busy || syncing || state === 'loading'">
      @if (state === 'loading') {
        <p class="attribute-notice" role="status">{{ 'featureAttribute.loading' | translate }}</p>
      } @else if (state === 'error') {
        <p class="attribute-notice attribute-notice-error" role="alert">{{ 'featureAttribute.loadError' | translate }}</p>
        <button type="button" (click)="retry.emit()">{{ 'featureAttribute.retry' | translate }}</button>
      } @else {
        @for (issue of issues; track issue) { <p class="attribute-notice attribute-notice-warning" role="status">{{ issue }}</p> }
        @if (syncing) {
          <p class="attribute-notice" role="status">{{ 'featureAttribute.saving' | translate }}</p>
        } @else if (pending) {
          <p class="attribute-notice" role="status">{{ 'featureAttribute.pendingServer' | translate }}</p>
        }
        @if (error) {
          <p class="attribute-notice attribute-notice-error" role="alert">{{ ('featureAttribute.' + error) | translate }} {{ conflictLabels }}</p>
          @if (error === 'conflict') {
            <button type="button" [disabled]="busy" (click)="reload.emit()">{{ 'featureAttribute.reload' | translate }}</button>
          }
          @if (error === 'registrationFailed') {
            <button type="button" [disabled]="busy" (click)="retryRegistration.emit()">{{ 'featureAttribute.retry' | translate }}</button>
          }
        }
        <form (submit)="submit($event)" novalidate>
          <fieldset [disabled]="busy || syncing">
            <legend>{{ 'featureAttribute.fields' | translate }}</legend>
            <p class="attribute-help">{{ 'featureAttribute.draftHelp' | translate }}</p>
            @if (rows.length === 0) { <p class="attribute-notice">{{ 'featureAttribute.empty' | translate }}</p> }
            @for (row of rows; track row.field.name; let index = $index) {
              <div class="attribute-field" [class.attribute-field-readonly]="!row.field.editable">
                @if (row.field.editable) {
                  <label [for]="row.group.controls.presence.value === 'value' ? 'attribute-value-' + index : 'attribute-presence-' + index">
                    {{ label(row.field) }}
                    @if (row.field.schema?.minOccurs === '1') { <span class="attribute-required" aria-hidden="true">*</span> }
                  </label>
                  <div class="attribute-inputs">
                  <select [id]="'attribute-presence-' + index" [formControl]="row.group.controls.presence"
                    class="attribute-presence"
                    [attr.aria-invalid]="row.error && row.group.controls.presence.value !== 'value' ? 'true' : null"
                    [attr.aria-describedby]="'attribute-error-' + index"
                    [attr.aria-label]="('featureAttribute.presence' | translate) + ' ' + label(row.field)">
                    @if (!row.field.present) {
                      <option value="absent">{{ 'featureAttribute.absent' | translate }}</option>
                    }
                    @if (row.field.schema?.nillable) { <option value="null">null</option> }
                    <option value="value">{{ 'featureAttribute.value' | translate }}</option>
                  </select>
                  @if (row.group.controls.presence.value === 'value') {
                    @if (!usesJson(row.field) && (enumerations(row.field).length > 0 || row.field.schema?.type === 'boolean')) {
                      <select [id]="'attribute-value-' + index" [formControl]="row.group.controls.text"
                        class="attribute-value" [attr.aria-required]="row.field.schema?.minOccurs === '1'"
                        [attr.aria-invalid]="row.error ? 'true' : null" [attr.aria-describedby]="'attribute-error-' + index">
                        @if (!options(row.field).includes(row.group.controls.text.value)) {
                          <option [value]="row.group.controls.text.value" disabled>{{ 'featureAttribute.choose' | translate }}</option>
                        }
                        @for (value of options(row.field); track value) { <option [value]="value">{{ value }}</option> }
                      </select>
                    } @else if (usesJson(row.field) || row.field.schema?.type === 'string') {
                      <textarea rows="2" [id]="'attribute-value-' + index" [formControl]="row.group.controls.text"
                        class="attribute-value" [attr.placeholder]="usesJson(row.field) ? 'JSON' : null" [attr.aria-required]="row.field.schema?.minOccurs === '1'"
                        [attr.aria-invalid]="row.error ? 'true' : null" [attr.aria-describedby]="'attribute-error-' + index"></textarea>
                    } @else {
                      <input type="text" [id]="'attribute-value-' + index" [formControl]="row.group.controls.text"
                        class="attribute-value" autocomplete="off" [attr.aria-required]="row.field.schema?.minOccurs === '1'"
                        [attr.inputmode]="row.field.schema?.type === 'int' ? 'numeric' : 'text'"
                        [attr.aria-invalid]="row.error ? 'true' : null" [attr.aria-describedby]="'attribute-error-' + index" />
                    }
                  }
                  </div>
                  <p [id]="'attribute-error-' + index" class="error">
                    @if (row.error) { {{ ('featureAttribute.' + row.error) | translate }} }
                  </p>
                } @else {
                  <div class="attribute-field-heading">
                    <label [for]="'attribute-readonly-' + index">{{ label(row.field) }}</label>
                    <span class="attribute-badge">{{ 'featureAttribute.readOnlyField' | translate }}</span>
                  </div>
                  <textarea readonly rows="2" [id]="'attribute-readonly-' + index" [value]="display(row.field)"
                    [attr.aria-describedby]="'attribute-reason-' + index"></textarea>
                  <div class="attribute-help" [id]="'attribute-reason-' + index">
                  @for (reason of row.field.reasons; track reason) { <p>{{ reason }}</p> }
                  </div>
                }
              </div>
            }
          </fieldset>
          <div class="attribute-actions">
          <p class="attribute-draft-status" role="status">{{ (dirty ? 'featureAttribute.draftChanged' : 'featureAttribute.draftClean') | translate }}</p>
          <button class="attribute-apply" type="submit" [disabled]="busy || syncing || !dirty">
            {{ 'featureAttribute.apply' | translate }}
          </button>
          <button type="button" [disabled]="busy || syncing" (click)="cancel.emit()">{{ 'featureAttribute.cancel' | translate }}</button>
          </div>
        </form>
      }
    </section>
  `,
  styleUrl: './feature-attribute-form.component.css'
})
export class FeatureAttributeFormComponent implements OnChanges, OnDestroy {
  @Input() state: 'loading' | 'error' | 'ready' = 'loading';
  @Input() fields: AttributeFormField[] = [];
  @Input() issues: string[] = [];
  @Input() busy = false;
  @Input() pending = false;
  @Input() syncing = false;
  @Input() error = '';
  @Input() conflictNames: string[] = [];
  @Output() readonly dirtyChanged = new EventEmitter<boolean>();
  @Output() readonly apply = new EventEmitter<ReadonlyMap<string, AttributeInput>>();
  @Output() readonly cancel = new EventEmitter<void>();
  @Output() readonly retry = new EventEmitter<void>();
  @Output() readonly reload = new EventEmitter<void>();
  @Output() readonly retryRegistration = new EventEmitter<void>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly subscriptions: Subscription[] = [];
  private previousFields?: AttributeFormField[];
  rows: FieldRow[] = [];
  dirty = false;

  ngOnChanges(): void {
    if (this.previousFields === this.fields) return;
    this.previousFields = this.fields;
    this.unsubscribe();
    this.rows = this.fields.map((field) => {
      let initial = field.initialInput ?? attributeInput(field.value, field.present, field.schema ?? undefined);
      if (field.editable && field.schema && !this.usesJson(field) && initial.presence === 'value' &&
          (field.schema.type === 'boolean' || this.enumerations(field).length > 0)) {
        // Select option values are canonical; retain the original lexical value
        // on the field so merely opening the form never mutates native data.
        try {
          const option = this.options(field).find((value) => attributeValuesEqual(field.schema!, field.value, value));
          initial = { ...initial, text: option ?? String(attributeScalarValue(field.schema, initial.text)) };
        }
        catch { /* Invalid drafts remain visible for normal field validation. */ }
      }
      const group = new FormGroup<AttributeControls>({
        presence: new FormControl(initial.presence, { nonNullable: true }),
        text: new FormControl(initial.text, { nonNullable: true })
      });
      const row: FieldRow = { field, group, initial, error: '' };
      this.subscriptions.push(group.valueChanges.subscribe(() => this.updateDirty()));
      return row;
    });
    this.updateDirty();
  }

  enumerations(field: AttributeFormField): string[] {
    return field.schema?.facets.filter((facet) => facet.name === 'enumeration').map((facet) => facet.value) ?? [];
  }

  label(field: AttributeFormField): string { return field.name.split(':').at(-1)!; }
  get conflictLabels(): string { return this.conflictNames.map((name) => name.split(':').at(-1)).join(', '); }
  usesJson(field: AttributeFormField): boolean { return !!field.schema && fieldUsesJson(field.schema); }

  options(field: AttributeFormField): string[] {
    const values = this.enumerations(field);
    return [...new Set(values.length ? values.map((text) => {
      if (field.schema?.type === 'int') return String(Number(text));
      if (field.schema?.type === 'boolean') return String(text === 'true' || text === '1');
      return text;
    }) : ['true', 'false'])];
  }

  display(field: AttributeFormField): string {
    if (!field.present) return '∅';
    try { return JSON.stringify(field.value) ?? String(field.value); }
    catch { return String(field.value); }
  }

  private updateDirty(): void {
    this.dirty = this.rows.some((row) => {
      if (!row.field.editable || !row.field.schema) return false;
      try {
        const value = parseAttributeInput(row.field.schema, row.group.getRawValue());
        return (value !== undefined) !== row.field.present || !attributeValuesEqual(row.field.schema, value, row.field.value);
      } catch {
        const input = row.group.getRawValue();
        return input.presence !== row.initial.presence || input.text !== row.initial.text;
      }
    });
    this.dirtyChanged.emit(this.dirty);
  }

  submit(event: Event): void {
    event.preventDefault();
    if (this.busy || this.syncing || !this.dirty) return;
    const inputs = new Map<string, AttributeInput>();
    let invalid = false;
    for (const row of this.rows) {
      if (!row.field.editable || !row.field.schema) continue;
      const input = row.group.getRawValue();
      row.error = '';
      // Unchanged optional/required absent fields are validated too on Apply.
      try { parseAttributeInput(row.field.schema, input); }
      catch (error) { row.error = error instanceof Error ? error.message : 'invalidValue'; invalid = true; }
      inputs.set(row.field.name, input);
    }
    if (invalid) {
      this.changeDetector.detectChanges();
      const rowIndex = this.rows.findIndex((row) => !!row.error);
      const invalidRow = this.rows[rowIndex];
      const selector = invalidRow?.group.controls.presence.value === 'value'
        ? `#attribute-value-${rowIndex}`
        : `#attribute-presence-${rowIndex}`;
      this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus();
      return;
    }
    this.apply.emit(inputs);
  }

  private unsubscribe(): void { this.subscriptions.splice(0).forEach((sub) => sub.unsubscribe()); }
  ngOnDestroy(): void { this.unsubscribe(); }
}
