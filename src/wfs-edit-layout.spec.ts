import { readFileSync } from 'fs';
import path from 'path';

describe('WFSEdit theme integration', () => {
  it('places a single collapsed editor in the tools panel', () => {
    const markup = readFileSync(
      path.join(process.cwd(), 'src/assets/map-styles/sitmun-base/markup.html'),
      'utf8'
    );
    const layout = document.createElement('div');
    layout.innerHTML = markup;

    expect(layout.querySelectorAll('#tc-slot-wfsedit')).toHaveLength(1);
    expect(
      layout.querySelector(
        '.tc-left-panel .tc-panel-content #tc-slot-wfsedit.tc-collapsed[data-tools-tab]'
      )
    ).not.toBeNull();
  });
});
