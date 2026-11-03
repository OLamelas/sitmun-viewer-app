import { ApplicationRef, Component, OnDestroy } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { MapFeaturePanelOptions, MapFeaturePanelService } from './map-feature-panel.service';

@Component({ selector: 'app-panel-test-content', standalone: true, template: '<input [value]="value">' })
class TestContentComponent implements OnDestroy {
  value = 'draft';
  static destroyed = 0;
  ngOnDestroy(): void { TestContentComponent.destroyed++; }
}

describe('MapFeaturePanelService', () => {
  let service: MapFeaturePanelService;
  let host: HTMLElement;
  const owner = {};
  const options = (overrides: Partial<MapFeaturePanelOptions> = {}): MapFeaturePanelOptions => ({
    owner, contextKey: 'feature/1', title: 'Attributes', closeLabel: 'Close',
    mount: content => { content.textContent = 'content'; return () => content.replaceChildren(); },
    ...overrides
  });

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MapFeaturePanelService);
    host = document.createElement('div');
    document.body.appendChild(host);
    TestContentComponent.destroyed = 0;
  });
  afterEach(() => { service.destroyAll(); host.remove(); });

  it('reuses a context without remounting and replaces different owners exactly once', async () => {
    const cleanup = jest.fn();
    const mount = jest.fn(() => cleanup);
    const first = await service.open(host, options({ mount }));
    const closed = jest.fn();
    first!.closed$.subscribe(closed);
    expect(await service.open({ div: host }, options({ mount }))).toBe(first);
    expect(mount).toHaveBeenCalledTimes(1);
    const second = await service.open(host, options({ owner: {}, contextKey: 'editor/1' }));
    expect(host.querySelectorAll('.sitmun-map-feature-panel')).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(first!.isCurrent).toBe(false);
    const staleWrite = jest.fn();
    expect(first!.update(staleWrite)).toBe(false);
    expect(staleWrite).not.toHaveBeenCalled();
    expect(second!.isCurrent).toBe(true);
    expect(await first!.requestClose()).toBe(false);
    expect(second!.isCurrent).toBe(true);
  });

  it('keeps the content and draft when a replacement or close is refused', async () => {
    const canClose = jest.fn().mockResolvedValue(false);
    const cleanup = jest.fn();
    const first = await service.open(host, options({ canClose, mount: () => cleanup }));
    const mount = jest.fn();
    expect(await service.open(host, options({ owner: {}, mount }))).toBeNull();
    expect(canClose).toHaveBeenLastCalledWith('replace');
    expect(await first!.requestClose()).toBe(false);
    expect(canClose).toHaveBeenLastCalledWith('close');
    expect(first!.isCurrent).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });

  it('does not forward the close click to the map even when closure destroys the host synchronously', async () => {
    const cleanup = jest.fn();
    const mapClick = jest.fn();
    host.addEventListener('click', mapClick);
    const ref = await service.open(host, options({ mount: () => cleanup }));
    host.querySelector<HTMLElement>('.sitmun-map-feature-panel-close')!.click();
    expect(ref!.isCurrent).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(mapClick).not.toHaveBeenCalled();
  });

  it('shares one pending confirmation and blocks stacked replacement intents', async () => {
    let resolve!: (allowed: boolean) => void;
    const canClose = jest.fn(() => new Promise<boolean>(done => { resolve = done; }));
    await service.open(host, options({ canClose }));
    const replacement = service.open(host, options({ owner: {} }));
    expect(await service.open(host, options({ owner: {} }))).toBeNull();
    await Promise.resolve();
    expect(canClose).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await replacement).not.toBeNull();
  });

  it('shares one guard across repeated close requests and releases content once', async () => {
    let resolve!: (allowed: boolean) => void;
    const canClose = jest.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const cleanup = jest.fn();
    const ref = await service.open(host, options({ canClose, mount: () => cleanup }));
    const first = ref!.requestClose();
    const second = ref!.requestClose();
    await Promise.resolve();
    expect(canClose).toHaveBeenCalledTimes(1);
    resolve(true);
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a throwing guard and accepts only explicit true', async () => {
    const canClose = jest.fn().mockRejectedValue(new Error('dialog failed'));
    const ref = await service.open(host, options({ canClose }));
    expect(await ref!.requestClose()).toBe(false);
    canClose.mockResolvedValue(undefined);
    expect(await ref!.requestClose()).toBe(false);
    canClose.mockResolvedValue(true);
    expect(await ref!.requestClose()).toBe(true);
  });

  it.each(['map', 'auth'])('does not resurrect a pending replacement after %s destruction', async cause => {
    let resolve!: (allowed: boolean) => void;
    const cleanup = jest.fn();
    await service.open(host, options({ mount: () => cleanup,
      canClose: () => new Promise<boolean>(done => { resolve = done; }) }));
    const mount = jest.fn();
    const replacement = service.open(host, options({ owner: {}, mount }));
    await Promise.resolve();
    if (cause === 'map') service.destroyMap(host); else service.destroyAll();
    resolve(true);
    expect(await replacement).toBeNull();
    expect(mount).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.sitmun-map-feature-panel')).toBeNull();
  });

  it('revalidates an asynchronous opening intent before destroying current content', async () => {
    let valid = true;
    let resolve!: (allowed: boolean) => void;
    const first = await service.open(host, options({
      canClose: () => new Promise<boolean>(done => { resolve = done; })
    }));
    const pending = service.open(host, options({ owner: {}, isValid: () => valid }));
    await Promise.resolve();
    valid = false;
    resolve(true);
    expect(await pending).toBeNull();
    expect(first!.isCurrent).toBe(true);
  });

  it('mounts a live Angular component and destroys/detaches it on closure', async () => {
    const app = TestBed.inject(ApplicationRef);
    const views = app.viewCount;
    const ref = await service.open(host, options({
      mount: content => service.mountComponent(content, TestContentComponent,
        component => { component.instance.value = 'independent draft'; })
    }));
    expect(host.querySelector('input')?.value).toBe('independent draft');
    expect(app.viewCount).toBe(views + 2);
    await ref!.requestClose();
    expect(TestContentComponent.destroyed).toBe(1);
    expect(app.viewCount).toBe(views);
    expect(host.children).toHaveLength(0);
  });

  it('cleans up a failed component mount without leaving attached Angular views', async () => {
    const app = TestBed.inject(ApplicationRef);
    const views = app.viewCount;
    await expect(service.open(host, options({
      mount: content => service.mountComponent(content, TestContentComponent, () => { throw new Error('mount'); })
    }))).rejects.toThrow('mount');
    expect(TestContentComponent.destroyed).toBe(1);
    expect(app.viewCount).toBe(views);
    expect(host.children).toHaveLength(0);
  });

  it('restores original focus through a replacement, without trapping focus in the map', async () => {
    const opener = document.createElement('button');
    host.append(opener);
    opener.focus();
    await service.open(host, options());
    const ref = await service.open(host, options({ owner: {} }));
    expect(document.activeElement?.classList.contains('sitmun-map-feature-panel')).toBe(true);
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await ref!.requestClose();
    expect(document.activeElement).toBe(opener);
  });

  it('isolates maps and prevents one owner from destroying another', async () => {
    const other = document.createElement('div');
    document.body.append(other);
    const first = await service.open(host, options());
    const second = await service.open(other, options());
    service.destroyOwner(host, {});
    expect(first!.isCurrent).toBe(true);
    service.destroyMap(host);
    expect(first!.isCurrent).toBe(false);
    expect(second!.isCurrent).toBe(true);
    service.destroyAll();
    expect(second!.isCurrent).toBe(false);
    other.remove();
  });
});
