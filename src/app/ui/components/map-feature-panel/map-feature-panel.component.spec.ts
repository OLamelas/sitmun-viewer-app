import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MapFeaturePanelComponent } from './map-feature-panel.component';

describe('MapFeaturePanelComponent', () => {
  let fixture: ComponentFixture<MapFeaturePanelComponent>;
  let host: HTMLElement;
  let panel: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MapFeaturePanelComponent] });
    fixture = TestBed.createComponent(MapFeaturePanelComponent);
    host = document.createElement('div');
    document.body.append(host);
    panel = fixture.nativeElement;
    host.append(panel);
    fixture.componentInstance.title = 'Layer attributes';
    fixture.componentInstance.closeLabel = 'Close';
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    host.remove();
  });

  it('labels a non-modal dialog and keeps Escape from closing it', () => {
    const close = jest.fn();
    fixture.componentInstance.requestClose = close;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).not.toBe('true');
    expect(
      panel.querySelector(`#${panel.getAttribute('aria-labelledby')}`)
        ?.textContent
    ).toBe('Layer attributes');
    panel
      .querySelector('.sitmun-map-feature-panel-close')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(close).toHaveBeenCalledTimes(1);
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    });
    panel.dispatchEvent(escape);
    expect(close).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(false);
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    });
    panel.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it.each(['Enter', ' '])('accepts the keyboard-generated close click for %j, without duplicating pointer gestures', (key) => {
    const close = jest.fn();
    fixture.componentInstance.requestClose = close;
    const button = panel.querySelector<HTMLElement>('.sitmun-map-feature-panel-close')!;
    button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    button.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    // JSDOM does not synthesize the browser's activation click from keyboard events.
    button.click();
    expect(close).toHaveBeenCalledTimes(1);
    button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    button.click();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'click',
    'dblclick',
    'wheel',
    'keydown'
  ])('does not send content %s gestures to the map', (type) => {
    const mapListener = jest.fn();
    host.addEventListener(type, mapListener);
    fixture.componentInstance.content.nativeElement.dispatchEvent(
      new Event(type, { bubbles: true })
    );
    expect(mapListener).not.toHaveBeenCalled();
  });

  it('clamps drag and resize to the map, not the browser viewport', () => {
    Object.defineProperties(host, {
      clientWidth: { value: 500 },
      clientHeight: { value: 320 }
    });
    Object.defineProperties(panel, {
      offsetWidth: { value: 200 },
      offsetHeight: { value: 100 }
    });
    fixture.componentInstance.place(2000, -100);
    expect(panel.style.left).toBe('288px');
    expect(panel.style.top).toBe('12px');
    expect(panel.style.maxWidth).toBe('476px');
    expect(panel.style.maxHeight).toBe('296px');
  });

  it('starts dragging only from noninteractive toolbar space and raises the panel', () => {
    const capture = jest.fn();
    panel.setPointerCapture = capture;
    const front = jest.fn();
    fixture.componentInstance.bringToFront = front;
    const pointer = (target: Element) =>
      target.dispatchEvent(
        Object.assign(
          new MouseEvent('pointerdown', { button: 0, bubbles: true }),
          { pointerId: 1 }
        )
      );
    pointer(panel.querySelector('.sitmun-map-feature-panel-close')!);
    expect(capture).not.toHaveBeenCalled();
    pointer(panel.querySelector('.sitmun-map-feature-panel-title')!);
    expect(capture).toHaveBeenCalledWith(1);
    expect(front).toHaveBeenCalledTimes(2);
  });

  it('disconnects resize observers when destroyed', () => {
    const original = globalThis.ResizeObserver;
    const disconnect = jest.fn();
    const observe = jest.fn();
    globalThis.ResizeObserver = class {
      observe = observe;
      unobserve = jest.fn();
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
    try {
      fixture.componentInstance.initializeBounds();
      expect(observe).toHaveBeenCalledWith(host);
      fixture.componentInstance.ngOnDestroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
