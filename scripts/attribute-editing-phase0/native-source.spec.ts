import { readFileSync } from 'fs';

import { nativeHistoryConstructor, nativeSource } from './native-source';

jest.mock('fs', () => ({ readFileSync: jest.fn() }));

const readSource = jest.mocked(readFileSync);

describe('Phase 0: native source encoding', () => {
  it.each([
    { bom: '', newline: '\n' },
    { bom: '\uFEFF', newline: '\n' },
    { bom: '', newline: '\r\n' },
    { bom: '\uFEFF', newline: '\r\n' }
  ])('normalizes the source before import extraction: %j', ({ bom, newline }) => {
    const eventSource = 'export default class FeatureHistoryEvent extends Event {}';
    const historySource = [
      "import FeatureHistoryEvent from './FeatureHistoryEvent.js';",
      '',
      'class FeatureHistory extends EventTarget {}',
      'export default FeatureHistory;'
    ].join(newline);
    readSource.mockReturnValueOnce(bom + eventSource).mockReturnValueOnce(bom + historySource);

    const History = nativeHistoryConstructor();

    expect(new History()).toBeInstanceOf(EventTarget);
  });

  it('removes only the leading BOM, preserving BOM characters inside attribute literals', () => {
    readSource.mockReturnValueOnce('\uFEFFconst label = "\uFEFFvalue";\r\n');

    expect(nativeSource('fixture.js')).toBe('const label = "\uFEFFvalue";\n');
  });
});
