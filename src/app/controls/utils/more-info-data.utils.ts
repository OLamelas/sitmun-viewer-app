export type MoreInfoRow = Record<string, any>;

export function normalizeMoreInfoRows(data: any): MoreInfoRow[] {
  if (data == null) return [];

  if (typeof data === 'string') {
    return normalizeStringData(data);
  }

  if (Array.isArray(data)) {
    return normalizeArrayData(data);
  }

  if (typeof data === 'object') {
    if (!hasNestedValues(data)) {
      return [data];
    }

    return flattenToPathRows(data);
  }

  return [{ value: data }];
}

function normalizeStringData(data: string): MoreInfoRow[] {
  const trimmed = data.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      return normalizeMoreInfoRows(parsed);
    } catch {
      return [{ value: data }];
    }
  }

  return [{ value: data }];
}

function normalizeArrayData(data: any[]): MoreInfoRow[] {
  if (data.length === 0) return [];

  if (
    data.every((item) => item && typeof item === 'object') &&
    data.every((item) => !hasNestedValues(item))
  ) {
    return data;
  }

  return flattenToPathRows(data);
}

function flattenToPathRows(data: any): MoreInfoRow[] {
  const rows: Array<{ field: string; value: string }> = [];

  const walk = (value: any, path: string): void => {
    if (value === null || value === undefined) {
      rows.push({ field: path || 'value', value: '' });
      return;
    }

    if (isPrimitiveValue(value)) {
      rows.push({ field: path || 'value', value: String(value) });
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        rows.push({ field: path || 'value', value: '[]' });
        return;
      }

      value.forEach((item, index) => {
        const childPath = path
          ? path + '[' + String(index) + ']'
          : '[' + String(index) + ']';
        walk(item, childPath);
      });
      return;
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        rows.push({ field: path || 'value', value: '{}' });
        return;
      }

      keys.forEach((key) => {
        const childPath = path ? path + '.' + key : key;
        walk(value[key], childPath);
      });
    }
  };

  walk(data, '');
  return rows;
}

/**
 * Converts an XML string to an array of rows for table rendering.
 *
 * Strategy:
 * - Root with multiple children sharing the same tag → treat as array (each child = one row).
 * - Otherwise → flatten root children as { field, value } key-value pairs.
 * - Falls back to a single { value } row if parsing fails or the content is text-only.
 */
export function normalizeXmlRows(xmlText: string): MoreInfoRow[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText.trim(), 'application/xml');

  if (doc.querySelector('parsererror')) {
    return [{ value: xmlText }];
  }

  const root = doc.documentElement;
  const children = Array.from(root.children);

  if (children.length === 0) {
    const text = root.textContent?.trim() ?? '';
    return text ? [{ value: text }] : [];
  }

  const firstTag = children[0].tagName;
  const isRepeating =
    children.length > 1 && children.every((c) => c.tagName === firstTag);

  if (isRepeating) {
    return children.map(xmlElementToRow);
  }

  return children.map((el) => ({
    field: el.tagName,
    value: el.textContent?.trim() ?? '',
  }));
}

function xmlElementToRow(el: Element): MoreInfoRow {
  const row: MoreInfoRow = {};

  Array.from(el.attributes).forEach((attr) => {
    row[attr.name] = attr.value;
  });

  Array.from(el.children).forEach((child) => {
    row[child.tagName] = child.textContent?.trim() ?? '';
  });

  if (Object.keys(row).length === 0) {
    row['value'] = el.textContent?.trim() ?? '';
  }

  return row;
}

function hasNestedValues(value: any): boolean {
  if (!value || typeof value !== 'object') return false;

  return Object.values(value).some((item) => {
    return !!item && typeof item === 'object';
  });
}

function isPrimitiveValue(value: any): boolean {
  const valueType = typeof value;
  return (
    valueType === 'string' || valueType === 'number' || valueType === 'boolean'
  );
}
