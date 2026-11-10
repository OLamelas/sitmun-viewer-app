import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { of, Subject, throwError } from 'rxjs';
import type { AppCfg } from '../api/model/app-cfg';
import { CommonService } from '../api/services/common.service';
import { AuthenticationService } from '../auth/services/authentication.service';
import { MapFeaturePanelService } from './map-feature-panel.service';
import { WfsEditingPermissionsService } from './wfs-editing-permissions.service';

describe('WFS permission preflight', () => {
  let permissions: WfsEditingPermissionsService;
  let fresh: jest.Mock;
  let invalidated: Subject<HTMLElement | null>;
  let identity: string;
  const endpoint = 'http://localhost/middleware/proxy/1/2/WFS/5/8';
  const profile = (allowed = true): AppCfg => ({
    application: { id: 1, territoryId: 2 },
    layers: [{ id: 'layer/8', service: 'service/5', layers: ['app:roads'] }],
    services: [{ id: 'service/5', type: 'WFS', url: endpoint }],
    tasks: allowed ? [{ id: 'task/7', type: 'edition', typeId: 0, scope: 'feat-edit', layer: 'layer/8', url: endpoint,
      parameters: { typename: { value: 'app:roads' } } }] : [], trees: []
  } as unknown as AppCfg);

  function fixture() {
    const layer = { id: 'native-8', type: 'WFS', url: endpoint, featureType: ['app:roads'],
      options: { profileLayerId: 'layer/8' }, features: [{ data: { name: 'untouched' } }] };
    const history = { undo: jest.fn(), redo: jest.fn(), setData: jest.fn() };
    const modify = { setLayer: jest.fn(), activate: jest.fn(), deactivate: jest.fn() };
    class Edit {
      private value: unknown = null;
      get mode() { return this.value; }
      set mode(value: unknown) { this.value = value; }
      history = history;
      activate = jest.fn();
      deactivate = jest.fn();
      setLayer = jest.fn();
      setFeatureCoordinates = jest.fn();
      joinFeatures = jest.fn();
      cancel = jest.fn();
      modifyControl = modify;
      async getModifyControl() { return modify; }
    }
    const edit = new Edit();
    const setLayer = jest.fn(async (target) => { control.layer = target; return target; });
    const open = jest.fn(async () => { edit.activate(); });
    const editable = jest.fn(async (target) => target);
    // Native close deactivates tools but deliberately retains control.layer.
    const close = jest.fn(async () => { edit.deactivate(); });
    const control: any = { sitmunPermissionHooksVersion: 2, layer: null, div: document.createElement('div'),
      setLayer, openEditSession: open, getEditableLayer: editable, addLayer: jest.fn(),
      getEditControl: async () => edit, editControl: edit, applyEdits: jest.fn(),
      closeEditSession: close, discardEdits: jest.fn() };
    const map = { div: document.createElement('div'), workLayers: [layer],
      getLayer: (id: string) => id === layer.id ? layer : null, toast: jest.fn() };
    return { layer, edit, modify, history, control, map, setLayer, open, editable, close, nativeActivate: edit.activate, nativeUndo: history.undo,
      nativeCoordinates: edit.setFeatureCoordinates, nativeJoin: edit.joinFeatures, nativeChildSetLayer: modify.setLayer, nativeCancel: edit.cancel };
  }

  beforeEach(() => {
    fresh = jest.fn().mockReturnValue(of(profile()));
    invalidated = new Subject(); identity = 'alice';
    TestBed.configureTestingModule({ providers: [WfsEditingPermissionsService,
      { provide: CommonService, useValue: { fetchMapConfiguration: fresh } },
      { provide: TranslateService, useValue: { instant: (key: string) => key } },
      { provide: AuthenticationService, useValue: { getLoggedUsername: () => identity } },
      { provide: MapFeaturePanelService, useValue: { invalidated$: invalidated } }
    ] });
    permissions = TestBed.inject(WfsEditingPermissionsService);
  });

  it('rejects the old patch capability instead of silently installing an incomplete gate', () => {
    const f = fixture(); f.control.sitmunPermissionHooksVersion = 1;
    expect(() => permissions.install(f.control, f.map, profile())).toThrow('permission hooks');
  });

  it('invalidates direct close synchronously even when native close retains the layer', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    await f.control.setLayer(f.layer);
    const current = (f.modify as any).sitmunCaptureEditingPermission();
    const closing = f.control.closeEditSession();
    expect(f.control.sitmunCanMutate()).toBe(false); expect(current()).toBe(false);
    f.nativeActivate.mockClear(); f.edit.activate(); f.history.undo();
    expect(f.nativeActivate).not.toHaveBeenCalled(); expect(f.nativeUndo).not.toHaveBeenCalled();
    await closing; expect(f.control.layer).toBe(f.layer);
    const calls = fresh.mock.calls.length;
    await f.control.openEditSession();
    expect(fresh).toHaveBeenCalledTimes(calls + 1); expect(f.control.sitmunCanMutate()).toBe(true);
    expect(current()).toBe(false); expect(f.layer.features[0].data.name).toBe('untouched');
  });

  it('does not reuse a pre-close profile response for the first legitimate reopening', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    const old = new Subject<AppCfg>(); fresh.mockReturnValueOnce(old);
    const pending = f.control.setLayer(f.layer);
    await f.control.closeEditSession();
    const reopened = f.control.setLayer(f.layer);
    await reopened;
    old.next(profile(false)); old.complete(); await pending;
    expect(fresh).toHaveBeenCalledTimes(2); expect(f.setLayer).toHaveBeenCalledTimes(1);
    expect(f.control.sitmunCanMutate()).toBe(true);
  });

  it.each(['denied', 'offline'])('requires a fresh permission after close (%s)', async (reason) => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    await f.control.setLayer(f.layer); await f.control.closeEditSession();
    fresh.mockReturnValue(reason === 'denied' ? of(profile(false)) : throwError(() => new Error('offline')));
    await f.control.openEditSession();
    expect(f.control.sitmunCanMutate()).toBe(false); expect(f.open).not.toHaveBeenCalled();
  });

  it('preserves only the destination attempt during internal cleanup, never old-layer mutation', async () => {
    const f = fixture();
    const b = { ...f.layer, id: 'native-b' }; f.map.workLayers.push(b);
    permissions.install(f.control, f.map, profile());
    await f.control.setLayer(f.layer);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    f.close.mockImplementation(async () => { reached(); await ready; });
    f.setLayer.mockImplementation(async (target) => {
      const current = f.control.sitmunCaptureLayerAttempt(target);
      await f.control.sitmunCloseLayerTransition(target, current);
      if (!current()) return null;
      f.control.layer = target; return target;
    });
    const switching = f.control.setLayer(b); await entered;
    expect(f.control.sitmunCanMutate()).toBe(false);
    f.nativeActivate.mockClear(); f.edit.activate();
    expect(f.nativeActivate).not.toHaveBeenCalled();
    release(); await switching;
    expect(f.control.layer).toBe(b); expect(f.control.sitmunCanMutate()).toBe(true);
  });

  it('explicit close cancels even the specifically identified internal layer transition', async () => {
    const f = fixture(); const b = { ...f.layer, id: 'native-b' }; f.map.workLayers.push(b);
    permissions.install(f.control, f.map, profile()); await f.control.setLayer(f.layer);
    let release!: () => void; let reached!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    f.close.mockImplementationOnce(async () => { reached(); await ready; });
    f.setLayer.mockImplementation(async (target) => {
      const current = f.control.sitmunCaptureLayerAttempt(target);
      await f.control.sitmunCloseLayerTransition(target, current);
      if (!current()) return null;
      f.control.layer = target; return target;
    });
    const switching = f.control.setLayer(b); await entered;
    const closed = f.control.closeEditSession();
    expect(f.control.sitmunCanMutate()).toBe(false);
    release(); await switching; await closed;
    expect(f.control.layer).toBe(f.layer); expect(f.control.sitmunCanMutate()).toBe(false);
    expect(f.layer.features[0].data.name).toBe('untouched');
  });

  it('does not let a late failed activation freeze a later freshly authorized opening', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile()); await f.control.setLayer(f.layer);
    let release!: () => void; let reached!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    f.open.mockImplementationOnce(async () => { reached(); await ready; throw new Error('late activation'); });
    const old = f.control.openEditSession(); await entered;
    await f.control.closeEditSession(); const next = f.control.openEditSession();
    release(); await old; await next;
    expect(f.control.sitmunCanMutate()).toBe(true); expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.map.toast).not.toHaveBeenCalled();
  });

  it('does not allow the global importer gate while an opening still has the previous edit layer', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile()); await f.control.setLayer(f.layer);
    (f.edit as any).layer = { ...f.layer, id: 'previous' };
    let release!: () => void; let reached!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    f.open.mockImplementationOnce(async () => { reached(); await ready; (f.edit as any).layer = f.layer; });
    const opening = f.control.openEditSession(); await entered;
    expect(f.control.sitmunCanMutate()).toBe(false);
    release(); await opening; expect(f.control.sitmunCanMutate()).toBe(true);
  });

  it('does not let a pre-close save refresh freeze or overwrite the newly opened session', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile()); await f.control.setLayer(f.layer);
    const old = new Subject<AppCfg>(); fresh.mockReturnValueOnce(old);
    const saving = f.control.applyEdits(); await f.control.closeEditSession();
    await f.control.openEditSession();
    old.next(profile(false)); old.complete(); await saving;
    expect(f.control.sitmunCanMutate()).toBe(true);
    expect(f.map.toast).not.toHaveBeenCalled();
  });

  it('keeps discard distinct from closing, including repeated close and failed native cleanup', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile()); await f.control.setLayer(f.layer);
    await f.control.discardEdits(); expect(f.control.sitmunCanMutate()).toBe(true);
    f.close.mockRejectedValueOnce(new Error('cleanup'));
    await expect(f.control.closeEditSession()).rejects.toThrow('cleanup');
    expect(f.control.sitmunCanMutate()).toBe(false);
    await f.control.closeEditSession(); await f.control.openEditSession();
    expect(f.control.sitmunCanMutate()).toBe(true);
  });

  it('denies before native selection, recovery, editable-layer resolution or consent', async () => {
    const f = fixture(); const before = JSON.stringify(f.layer);
    fresh.mockReturnValue(of(profile(false)));
    permissions.install(f.control, f.map, profile(false));
    await f.control.sitmunProtectEditControl(f.edit);
    const consent = jest.fn();
    await f.control.sitmunWithLayerPermission(f.layer, consent);
    expect(await f.control.setLayer(f.layer)).toBeNull();
    await f.control.openEditSession();
    await expect(f.control.getEditableLayer(f.layer)).rejects.toThrow();
    expect(consent).not.toHaveBeenCalled();
    expect(f.setLayer).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
    expect(f.editable).not.toHaveBeenCalled(); expect(JSON.stringify(f.layer)).toBe(before);
    f.edit.activate(); f.edit.setFeatureCoordinates(); f.edit.joinFeatures(); f.history.undo();
    expect(f.nativeActivate).not.toHaveBeenCalled(); expect(f.nativeCoordinates).not.toHaveBeenCalled();
    expect(f.nativeJoin).not.toHaveBeenCalled(); expect(f.nativeUndo).not.toHaveBeenCalled();
  });

  it('uses a real refresh even when the initial profile has no tasks, and authorizes before consent', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile(false));
    const order: string[] = [];
    fresh.mockImplementation(() => { order.push('permission'); return of(profile()); });
    await f.control.sitmunWithLayerPermission(f.layer, async () => {
      order.push('consent'); return f.control.setLayer(f.layer);
    });
    expect(order).toEqual(['permission', 'consent']);
    expect(f.setLayer).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledWith(1, 2, undefined, { refresh: true });
    await f.control.openEditSession(); expect(f.open).toHaveBeenCalledTimes(1);
  });

  it('does not activate while pending and ignores a response from an invalidated map/identity', async () => {
    const f = fixture(); const response = new Subject<AppCfg>(); fresh.mockReturnValue(response);
    permissions.install(f.control, f.map, profile());
    const pending = f.control.setLayer(f.layer);
    expect(f.setLayer).not.toHaveBeenCalled();
    identity = 'bob'; invalidated.next(null); response.next(profile()); response.complete();
    await pending; expect(f.setLayer).not.toHaveBeenCalled();
  });

  it('freezes controls/history on revocation but keeps features and cleanup available', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    await f.control.setLayer(f.layer); await f.control.openEditSession();
    fresh.mockReturnValue(of(profile(false)));
    await f.control.applyEdits();
    f.nativeActivate.mockClear(); f.edit.activate(); f.history.undo();
    expect(f.nativeActivate).not.toHaveBeenCalled(); expect(f.nativeUndo).not.toHaveBeenCalled();
    expect(f.layer.features[0].data).toEqual({ name: 'untouched' });
    await f.control.setLayer(null); expect(f.setLayer).toHaveBeenLastCalledWith(null);
  });

  it('fails closed on refresh failure without executing the native method', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    fresh.mockReturnValue(throwError(() => new Error('offline')));
    await f.control.setLayer(f.layer); expect(f.setLayer).not.toHaveBeenCalled();
  });

  it('allows deferred native child layer propagation only to the authorized active layer', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    let propagate: () => void = () => {};
    f.setLayer.mockImplementation(async (target) => {
      f.control.layer = target;
      propagate = () => f.modify.setLayer(target);
      return target;
    });
    await f.control.setLayer(f.layer);
    propagate();
    expect(f.nativeChildSetLayer).toHaveBeenCalledWith(f.layer);
    f.modify.setLayer({ ...f.layer, id: 'another-layer' });
    expect(f.nativeChildSetLayer).toHaveBeenCalledTimes(1);
    await f.control.setLayer(null);
    f.modify.setLayer(f.layer);
    expect(f.nativeChildSetLayer).toHaveBeenCalledTimes(1);
  });

  it('invalidates captured asynchronous activations on revocation and keeps native cleanup available', async () => {
    const f = fixture(); permissions.install(f.control, f.map, profile());
    await f.control.setLayer(f.layer);
    const current = (f.modify as any).sitmunCaptureEditingPermission();
    expect(current()).toBe(true);
    f.control.sitmunPermissionFailure({ status: 403 });
    expect(current()).toBe(false);
    f.close.mockImplementation(async () => {
      expect(await f.control.getEditableLayer(f.layer)).toBe(f.layer);
      f.edit.cancel();
      f.modify.setLayer(null);
    });
    await f.control.closeEditSession();
    expect(f.nativeCancel).toHaveBeenCalledTimes(1);
    expect(f.nativeChildSetLayer).toHaveBeenCalledWith(null);
    await f.control.openEditSession();
    expect(current()).toBe(false); // A new opening cannot revive the old activation.
  });

  it('cancels a pending opening on explicit close, and keeps disposed controls closed', async () => {
    const f = fixture(); const response = new Subject<AppCfg>(); fresh.mockReturnValue(response);
    permissions.install(f.control, f.map, profile());
    const pending = f.control.setLayer(f.layer);
    await f.control.setLayer(null);
    response.next(profile()); response.complete(); await pending;
    expect(f.setLayer).toHaveBeenCalledTimes(1); expect(f.setLayer).toHaveBeenCalledWith(null);
    permissions.clear(f.map); fresh.mockReturnValue(of(profile()));
    await f.control.setLayer(f.layer); expect(f.setLayer).toHaveBeenCalledTimes(1);
  });

  it('keeps permission decisions separate between two map instances', async () => {
    const a = fixture(); const b = fixture();
    permissions.install(a.control, a.map, profile()); permissions.install(b.control, b.map, profile(false));
    await a.control.setLayer(a.layer);
    fresh.mockReturnValue(of(profile(false)));
    await b.control.setLayer(b.layer);
    expect(a.setLayer).toHaveBeenCalledTimes(1); expect(b.setLayer).not.toHaveBeenCalled();
  });

  it('claims accepted legacy drafts once without overwriting newer scoped edits or deleting originals', async () => {
    const f = fixture(); const scoped = 'identity-prefix'; const old = 'legacy';
    const a = '.modified.roads.1'; const b = '.added.new.2';
    const items = new Map<string, unknown>([[old + a, { value: 'accepted' }], [scoped + a, { value: 'newer' }], [old + b, { value: 'accepted-b' }],
      [old + '.removed.roads.3', { value: 'removed' }]]);
    const store = { keys: async () => [...items.keys()], getItem: async (key: string) => items.get(key),
      setItem: async (key: string, value: unknown) => { items.set(key, value); return value; } };
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, action: () => unknown) => action() } });
    try {
      permissions.install(f.control, f.map, profile());
      f.setLayer.mockImplementation(async (target) => {
        expect(await f.control.sitmunMigrateLegacyDrafts(store, old, scoped)).toBe(true);
        f.control.layer = target; return target;
      });
      await f.control.setLayer(f.layer);
      expect(items.get(scoped + a)).toEqual({ value: 'newer' });
      expect(items.get(scoped + b)).toEqual({ value: 'accepted-b' });
      expect(items.get(scoped + '.removed.roads.3')).toEqual({ value: 'removed' });
      expect(items.get(old + b)).toEqual({ value: 'accepted-b' });
      items.delete(scoped + b); // Native successful save clears its scoped operations.
      await f.control.setLayer(f.layer);
      expect(items.has(scoped + b)).toBe(false); // Never replay retained legacy originals.
      identity = 'bob'; const second = fixture(); permissions.install(second.control, second.map, profile());
      second.setLayer.mockImplementation(async (target) => {
        await second.control.sitmunMigrateLegacyDrafts(store, old, 'bob.'); second.control.layer = target; return target;
      });
      await second.control.setLayer(second.layer); expect(items.has('bob.' + b)).toBe(false);
    } finally { if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks'); }
  });

  it.each(['https://host/wfs', 'https://host/proxy/8'])('delimits complete operation prefixes for %s inside the lock', async (endpoint) => {
    const f = fixture(); const old = 'draft.app:roads@' + endpoint;
    const scoped = 'scoped.' + old;
    const foreign = old + (endpoint.endsWith('/8') ? '0' : '2') + '.modified.roads.1';
    const items = new Map<string, unknown>([[foreign, { value: 'foreign' }]]);
    const store = { keys: async () => [...items.keys()], getItem: async (key: string) => items.get(key),
      setItem: jest.fn(async (key: string, value: unknown) => { items.set(key, value); return value; }) };
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const request = jest.fn(async (_key: string, action: () => unknown) => {
      items.set(old + '.modified.roads.2', { value: 'inside-lock' }); return action();
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      permissions.install(f.control, f.map, profile());
      f.setLayer.mockImplementation(async (target) => {
        expect(await f.control.sitmunMigrateLegacyDrafts(store, old, scoped)).toBe(true);
        f.control.layer = target; return target;
      });
      await f.control.setLayer(f.layer);
      expect(request).not.toHaveBeenCalled(); expect(store.setItem).not.toHaveBeenCalled();
      items.set(old + '.added.new.1', { value: 'own' });
      await f.control.setLayer(f.layer);
      expect(items.get(scoped + '.modified.roads.2')).toEqual({ value: 'inside-lock' });
      expect(items.get(scoped + '.added.new.1')).toEqual({ value: 'own' });
      expect(items.has(scoped + foreign.slice(old.length))).toBe(false);
      expect(items.get(foreign)).toEqual({ value: 'foreign' });
    } finally { if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks'); }
  });

  it('stops a copy after close, then resumes only the same incomplete claim without replacing newer values', async () => {
    const f = fixture(); const items = new Map<string, unknown>([['legacy.modified.roads.1', { value: 'old' }]]);
    let release!: () => void; let reached!: () => void; let wait = true;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const store = { keys: async () => [...items.keys()],
      getItem: async (key: string) => {
        if (wait && key === 'scoped.modified.roads.1') { reached(); await ready; }
        return items.get(key);
      }, setItem: async (key: string, value: unknown) => { items.set(key, value); return value; } };
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_: string, action: () => unknown) => action() } });
    try {
      permissions.install(f.control, f.map, profile());
      f.setLayer.mockImplementation(async (target) => {
        if (!await f.control.sitmunMigrateLegacyDrafts(store, 'legacy', 'scoped')) return null;
        f.control.layer = target; return target;
      });
      const pending = f.control.setLayer(f.layer); await entered;
      await f.control.closeEditSession(); release(); await pending;
      expect(items.has('scoped.modified.roads.1')).toBe(false);
      expect(items.get('sitmun-wfs-legacy-owner:legacy')).toEqual({ owner: 'scoped', complete: false });
      items.set('scoped.modified.roads.1', { value: 'newer' }); wait = false;
      await f.control.setLayer(f.layer);
      expect(items.get('scoped.modified.roads.1')).toEqual({ value: 'newer' });
      expect(items.get('sitmun-wfs-legacy-owner:legacy')).toEqual({ owner: 'scoped', complete: true });
      expect(items.get('legacy.modified.roads.1')).toEqual({ value: 'old' });
    } finally { if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks'); }
  });

  it.each(['keys', 'getItem', 'setItem', 'locks'])('fails closed without deleting drafts when %s is unavailable', async (failure) => {
    const f = fixture(); const items = new Map<string, unknown>([['legacy.modified.roads.1', { value: 'kept' }]]);
    const store = { keys: jest.fn(async () => [...items.keys()]), getItem: jest.fn(async (key: string) => items.get(key)),
      setItem: jest.fn(async (key: string, value: unknown) => { items.set(key, value); return value; }) };
    if (failure !== 'locks') (store[failure as keyof typeof store] as jest.Mock).mockRejectedValueOnce(new Error('storage'));
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: failure === 'locks' ? undefined : { request: async (_: string, action: () => unknown) => action() } });
    try {
      permissions.install(f.control, f.map, profile());
      f.setLayer.mockImplementation(async () => {
        expect(await f.control.sitmunMigrateLegacyDrafts(store, 'legacy', 'scoped')).toBe(false); return null;
      });
      await f.control.setLayer(f.layer);
      expect(f.control.sitmunCanMutate()).toBe(false); expect(items.get('legacy.modified.roads.1')).toEqual({ value: 'kept' });
      expect(items.get('sitmun-wfs-legacy-owner:legacy')).not.toEqual({ owner: 'scoped', complete: true });
    } finally { if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks'); }
  });
});
