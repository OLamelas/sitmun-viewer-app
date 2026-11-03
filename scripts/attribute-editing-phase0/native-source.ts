import { readFileSync } from 'fs';
import { join } from 'path';

/** Read installed, postinstall-patched sources. Missing dependencies must fail, not skip. */
export function nativeSource(path: string): string {
  return readFileSync(join(__dirname, '../../node_modules/api-sitna', path), 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}

export function between(source: string, start: string, end: string): string {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (first < 0 || last < 0) throw new Error(`SITNA source contract changed: ${start}`);
  return source.slice(first + start.length, last);
}

export function nativeHistoryConstructor(): new () => import('./native-bridge').AttributeHistory & {
  undo(feature: unknown): number;
  redo(feature: unknown): number;
  canUndo(feature: unknown): boolean;
} {
  const eventClass = new Function(
    nativeSource('TC/tool/FeatureHistoryEvent.js').replace('export default class', 'return class')
  )();
  const source = nativeSource('TC/tool/FeatureHistory.js')
    .replace(/^import .*;\n/m, '')
    .replace('export default FeatureHistory;', 'return FeatureHistory;');
  return new Function('FeatureHistoryEvent', source)(eventClass);
}
