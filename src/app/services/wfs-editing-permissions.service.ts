import { Injectable, OnDestroy, inject } from '@angular/core';
import type { AppCfg } from '@api/model/app-cfg';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { AuthenticationService } from '../auth/services/authentication.service';
import { NotificationService } from '../notifications/services/NotificationService';

import { CommonService } from '../api/services/common.service';
import { MapFeaturePanelService } from './map-feature-panel.service';
import { editingTask } from './wfs-editing-identity';

interface Attempt { layer: any; revision: number; }
interface DraftStore {
  keys(): Promise<string[]>;
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown): Promise<unknown>;
}
interface PermissionState {
  control: any;
  map: any;
  profile: AppCfg;
  alive: boolean;
  revision: number;
  epoch: number;
  identity: string;
  changing?: { layer: any };
  checking?: { layer: any; promise: Promise<Attempt | null> };
  setting?: { attempt: Attempt; promise: Promise<unknown> };
  opening?: { attempt: Attempt; promise: Promise<unknown> };
  closing?: Promise<unknown>;
  clearing?: Promise<unknown>;
  refresh?: Promise<boolean>;
  intent?: Attempt;
  preparing?: Attempt;
  prepared?: Attempt;
  active?: any;
  cleaning: number;
  protected: WeakSet<object>;
  controls: any[];
  dispose: (() => void)[];
}

/** Mandatory map/control-local gate. The attribute panel is only an optional consumer. */
@Injectable({ providedIn: 'root' })
export class WfsEditingPermissionsService implements OnDestroy {
  private readonly common = inject(CommonService);
  private readonly translate = inject(TranslateService);
  private readonly panels = inject(MapFeaturePanelService);
  private readonly authentication = inject(AuthenticationService);
  private readonly notifications = inject(NotificationService);
  private readonly states = new Map<any, PermissionState>();
  private readonly invalidation = this.panels.invalidated$.subscribe((host) => {
    for (const state of this.states.values()) {
      const div = typeof state.map.div === 'string' ? document.getElementById(state.map.div) : state.map.div;
      if (host === null || host === div) this.invalidate(state);
    }
  });

  install(control: any, map: any, profile: AppCfg): void {
    if (this.states.has(control)) return;
    if (control.sitmunPermissionHooksVersion !== 2 || !profile?.application?.territoryId ||
        !['setLayer', 'openEditSession', 'getEditableLayer', 'addLayer', 'applyEdits', 'closeEditSession'].every((name) => typeof control[name] === 'function')) {
      throw new Error('WFSEdit permission hooks or map context unavailable');
    }
    const state: PermissionState = {
      control, map, profile, alive: true, revision: 0, epoch: 0,
      identity: this.authentication.getLoggedUsername(), cleaning: 0,
      protected: new WeakSet(), controls: [], dispose: []
    };
    this.states.set(control, state);
    this.replace(state, control, 'sitmunStorageContext', encodeURIComponent(JSON.stringify([
      state.identity || 'public', profile.application.id, profile.application.territoryId
    ])) + '.');
    this.replace(state, control, 'sitmunMigrateLegacyDrafts', async (store: DraftStore, legacy: string, scoped: string, alternate?: string) => {
      if (!await this.migrateLegacyDrafts(state, store, legacy, scoped)) return false;
      return !alternate || alternate === legacy || this.migrateLegacyDrafts(state, store, alternate, scoped);
    });
    this.replace(state, control, 'sitmunCanEditLayer', (layer: any) => this.candidate(state, layer));
    this.replace(state, control, 'sitmunCanMutate', () => this.canMutate(state));
    this.replace(state, control, 'sitmunCaptureLayerAttempt', (layer: any) => {
      const attempt = [state.preparing, state.prepared, state.intent]
        .find((item) => this.current(state, item) && item?.layer === this.layer(state, layer));
      return () => this.current(state, attempt) && (state.preparing === attempt || state.prepared === attempt || state.intent === attempt) &&
        attempt?.layer === this.layer(state, layer);
    });
    this.replace(state, control, 'sitmunWithLayerPermission', (target: any, operation: () => Promise<unknown>) =>
      this.withIntent(state, target, operation));
    this.replace(state, control, 'sitmunProtectEditControl', (edit: any) => this.protectEdit(state, edit));
    this.replace(state, control, 'sitmunChangeEditingLayer', async (target: any) => {
      const change = { layer: this.layer(state, target) };
      try {
        if (!target) { await control.setLayer(null); return; }
        if (this.layer(state, target) === control.layer) {
          if (!this.canMutate(state)) await control.openEditSession();
          else await control.setLayer(null);
          return;
        }
        state.changing = change;
        const layer = await control.setLayer(target);
        if (state.changing === change && this.current(state, state.prepared) && layer && layer === change.layer) await control.openEditSession();
      } catch { this.message(state, 'wfsEditing.unavailable'); }
      finally { if (state.changing === change) state.changing = undefined; }
    });
    this.replace(state, control, 'sitmunPermissionFailure', (error: any) => {
      // Native error adapters do not consistently retain HTTP status. Any failed save
      // freezes this session until a fresh, explicitly authorized opening.
      this.freeze(state);
      this.message(state, [401, 403].includes(Number(error?.status ?? error?.code ?? error?.response?.status))
        ? 'wfsEditing.revoked' : 'wfsEditing.saveFailed');
    });
    const nativeSet = control.setLayer;
    this.replace(state, control, 'setLayer', (target: any, ...args: unknown[]) => {
      if (target == null) {
        this.endSession(state);
        const pending = Promise.resolve(this.cleanup(state, () => nativeSet.call(control, null, ...args)))
          .finally(() => { if (state.clearing === pending) state.clearing = undefined; });
        state.clearing = pending;
        return pending;
      }
      return this.withIntent(state, target, async () => {
        const attempt = state.intent!;
        const setting = state.setting;
        if (setting?.attempt === attempt) return setting.promise;
        const promise = (async () => {
          if (setting) await setting.promise;
          if (state.opening) await state.opening.promise;
          if (state.clearing) await state.clearing;
          if (state.closing) await state.closing;
          if (!this.current(state, attempt)) return null;
          await this.protectEdit(state, await control.getEditControl());
          if (!this.current(state, attempt)) return null;
          state.preparing = attempt;
          try {
            this.mediate(state, attempt.layer);
            const result = await nativeSet.call(control, target, ...args);
            if (!result || !this.current(state, attempt) || control.layer !== attempt.layer) return null;
            state.active = attempt.layer;
            state.controls.forEach((tool) => this.setToolInert(tool, false));
            control.sitmunEditingPermissionChanged?.(true);
            state.prepared = state.changing?.layer === attempt.layer ? attempt : undefined;
            return result;
          } finally { if (state.preparing === attempt) state.preparing = undefined; }
        })().finally(() => { if (state.setting?.promise === promise) state.setting = undefined; });
        state.setting = { attempt, promise };
        return promise;
      });
    });
    const nativeOpen = control.openEditSession;
    this.replace(state, control, 'openEditSession', async (...args: unknown[]) => {
      let attempt = state.prepared;
      state.prepared = undefined;
      if (!this.current(state, attempt) || attempt?.layer !== control.layer) attempt = await this.authorize(state, control.layer) ?? undefined;
      if (!this.current(state, attempt)) return;
      const pendingOpening = state.opening;
      if (pendingOpening && pendingOpening.attempt === attempt) return pendingOpening.promise;
      if (state.opening) await state.opening.promise;
      if (state.setting) await state.setting.promise;
      if (state.clearing) await state.clearing;
      if (state.closing) await state.closing;
      if (!this.current(state, attempt)) return;
      await this.protectEdit(state, await control.getEditControl());
      if (!this.current(state, attempt)) return;
      state.preparing = attempt;
      state.active = attempt!.layer;
      this.mediate(state, attempt!.layer);
      state.controls.forEach((tool) => this.setToolInert(tool, false));
      control.sitmunEditingPermissionChanged?.(true);
      const opening = { attempt: attempt!, promise: Promise.resolve() as Promise<unknown> };
      state.opening = opening;
      opening.promise = Promise.resolve().then(() => {
        if (this.current(state, attempt)) return nativeOpen.apply(control, args);
        return undefined;
      }).catch(() => {
        if (this.current(state, attempt)) { this.freeze(state); this.message(state, 'wfsEditing.unavailable'); }
      }).finally(() => {
        if (state.preparing === attempt) state.preparing = undefined;
        if (state.opening === opening) state.opening = undefined;
      });
      return opening.promise;
    });
    const nativeEditable = control.getEditableLayer;
    this.replace(state, control, 'getEditableLayer', async (target: any) => {
      const layer = this.layer(state, target);
      if (state.cleaning) {
        // Cleanup may resolve an existing layer, but must never manufacture a helper.
        if (layer?.wfsLayer) return layer.wfsLayer;
        if (layer?.type === 'WFS') return layer;
        throw new Error('No existing editable layer');
      }
      if (!this.candidate(state, layer)) throw new Error('WFS editing not authorized');
      const revision = state.revision;
      const editable = await nativeEditable.call(control, layer);
      if (revision !== state.revision || !this.candidate(state, layer)) throw new Error('Stale WFS layer resolution');
      return editable;
    });
    const nativeAdd = control.addLayer;
    this.replace(state, control, 'addLayer', (layer: any) => {
      if (this.candidate(state, layer)) return nativeAdd.call(control, layer);
      return undefined;
    });
    const nativeClose = control.closeEditSession;
    const close = (...args: unknown[]) => {
      // Serialize native cleanup too: a late deactivate must not affect a new session.
      const previous = state.closing;
      const pending = Promise.resolve(previous).catch(() => undefined)
        .then(() => this.cleanup(state, () => nativeClose.apply(control, args)))
        .finally(() => { if (state.closing === pending) state.closing = undefined; });
      state.closing = pending;
      return pending;
    };
    this.replace(state, control, 'closeEditSession', (...args: unknown[]) => {
      this.endSession(state); // Synchronous, before native cleanup's first await.
      return close(...args);
    });
    this.replace(state, control, 'sitmunCloseLayerTransition', (target: any, current: () => boolean) => {
      const attempt = state.preparing;
      if (!current() || !this.current(state, attempt) || attempt?.layer !== target) return Promise.resolve();
      this.freeze(state);
      state.preparing = attempt;
      return close(); // Only this native call site bypasses explicit-close invalidation.
    });
    const nativeDiscard = control.discardEdits;
    if (typeof nativeDiscard === 'function') this.replace(state, control, 'discardEdits', (...args: unknown[]) =>
      this.cleanup(state, () => nativeDiscard.apply(control, args)));
    const nativeSave = control.applyEdits;
    this.replace(state, control, 'applyEdits', async (...args: unknown[]) => {
      const revision = state.revision;
      const allowed = this.canMutate(state) && await this.refresh(state);
      if (revision !== state.revision) return;
      if (!allowed || !this.canMutate(state)) {
        this.freeze(state); this.message(state, 'wfsEditing.revoked'); return;
      }
      return nativeSave.apply(control, args);
    });
  }

  /** Called only after native register; install() has already secured auto-selection. */
  registered(control: any): void {
    const state = this.states.get(control);
    if (!state) return;
    const sync = () => this.syncCandidates(state);
    this.syncCandidates(state);
    const host = typeof state.map.div === 'string' ? document.getElementById(state.map.div) : state.map.div;
    if (host instanceof HTMLElement) {
      const observer = new MutationObserver(sync);
      observer.observe(host, { childList: true, subtree: true });
      state.dispose.push(() => observer.disconnect());
    }
    if (control.div instanceof HTMLElement) {
      let collapsed = control.div.classList.contains('tc-collapsed');
      const observer = new MutationObserver(() => {
        const next = control.div.classList.contains('tc-collapsed');
        if (collapsed && !next) void this.refresh(state).then(sync);
        collapsed = next;
      });
      observer.observe(control.div, { attributes: true, attributeFilter: ['class'] });
      state.dispose.push(() => observer.disconnect());
    }
  }

  clear(map?: object): void {
    for (const state of [...this.states.values()]) {
      if (map && map !== state.map) continue;
      this.invalidate(state);
      state.dispose.forEach((dispose) => dispose());
      // Disposed controls keep their fail-closed wrappers. Restoring their native
      // entry points would let a retained reference reactivate the old map.
      this.states.delete(state.control);
    }
  }

  ngOnDestroy(): void { this.invalidation.unsubscribe(); this.clear(); }

  reportUnavailable(): void {
    this.notifications.error(this.translate.instant('wfsEditing.unavailable'));
  }

  disable(control: any, map: any): void {
    const state = this.states.get(control);
    if (state) this.invalidate(state);
    for (const name of ['setLayer', 'openEditSession', 'applyEdits', 'addLayer', 'activate']) {
      Object.defineProperty(control, name, { configurable: true, writable: true, value: () => Promise.resolve(null) });
    }
    Object.defineProperty(control, 'getEditableLayer', { configurable: true, writable: true, value: () => Promise.resolve(null) });
    control.map = map;
    if (control.div instanceof HTMLElement) control.div.textContent = this.translate.instant('wfsEditing.unavailable');
    map.toast?.(this.translate.instant('wfsEditing.unavailable'));
  }

  private layer(state: PermissionState, target: any): any {
    return typeof target === 'string' ? state.map.getLayer?.(target) : target;
  }

  private candidate(state: PermissionState, target: any): boolean {
    const layer = this.layer(state, target);
    return state.alive && state.identity === this.authentication.getLoggedUsername() && !!layer &&
      (state.map.workLayers ?? []).includes(layer) && !!editingTask(state.profile, layer);
  }

  private current(state: PermissionState, attempt?: Attempt): boolean {
    return !!attempt && state.alive && attempt.revision === state.revision && this.candidate(state, attempt.layer);
  }

  private canMutate(state: PermissionState, tool?: any): boolean {
    const destination = state.preparing?.layer ?? state.active;
    if (tool?.layer && tool.layer !== destination && tool.layer !== destination?.wfsLayer) return false;
    const editLayer = state.control.editControl?.layer;
    if (editLayer && editLayer !== destination && editLayer !== destination?.wfsLayer) return false;
    return (this.current(state, state.preparing) && state.control.layer === destination) ||
      (state.alive && state.active === state.control.layer && this.candidate(state, state.active));
  }

  private refresh(state: PermissionState): Promise<boolean> {
    if (state.refresh) return state.refresh;
    if (!state.alive) return Promise.resolve(false);
    const epoch = state.epoch;
    const { id, territoryId } = state.profile.application;
    const pending = firstValueFrom(this.common.fetchMapConfiguration(id, territoryId!, undefined, { refresh: true }))
      .then((profile) => {
        if (state.refresh !== pending || !state.alive || epoch !== state.epoch || state.identity !== this.authentication.getLoggedUsername() ||
            profile.application.id !== id || profile.application.territoryId !== territoryId) return false;
        state.profile = profile;
        if (state.active && !this.candidate(state, state.active)) this.freeze(state);
        this.syncCandidates(state);
        return true;
      }).catch(() => {
        return false;
      }).finally(() => { if (state.refresh === pending) state.refresh = undefined; });
    state.refresh = pending;
    return pending;
  }

  private authorize(state: PermissionState, target: any): Promise<Attempt | null> {
    const layer = this.layer(state, target);
    const checking = state.checking;
    if (checking && checking.layer === layer) return checking.promise;
    const revision = ++state.revision;
    state.prepared = undefined;
    // Do not use the initial task index to reject a newly granted permission.
    const promise = (async (): Promise<Attempt | null> => {
      if (!layer || !await this.refresh(state) || revision !== state.revision || !this.candidate(state, layer)) {
        if (state.alive && revision === state.revision) this.message(state,
          layer?.type === 'WMS' ? 'wfsEditing.wmsUnverified' : 'wfsEditing.denied');
        return null;
      }
      return { layer, revision };
    })().finally(() => { if (state.checking?.promise === promise) state.checking = undefined; });
    state.checking = { layer, promise };
    return promise;
  }

  private async withIntent(state: PermissionState, target: any, operation: () => Promise<unknown>): Promise<unknown> {
    if (target == null) return operation();
    const layer = this.layer(state, target);
    if (state.intent?.layer === layer && this.current(state, state.intent)) return operation();
    const attempt = await this.authorize(state, target);
    if (!attempt) return null;
    state.intent = attempt;
    try { return this.current(state, attempt) ? await operation() : null; }
    catch { if (attempt.revision === state.revision) { this.freeze(state); this.message(state, 'wfsEditing.unavailable'); } return null; }
    finally { if (state.intent === attempt) state.intent = undefined; }
  }

  private async protectEdit(state: PermissionState, edit: any): Promise<void> {
    if (!edit) throw new Error('WFSEdit edit control unavailable');
    const children = await Promise.all(['getModifyControl', 'getPointDrawControl', 'getLineDrawControl', 'getPolygonDrawControl']
      .map((name) => typeof edit[name] === 'function' ? edit[name]() : undefined));
    const editors = await Promise.all(['getModifyControlAttributeEditor', 'getPointDrawControlAttributeEditor',
      'getLineDrawControlAttributeEditor', 'getPolygonDrawControlAttributeEditor']
      .map((name) => typeof edit[name] === 'function' ? edit[name]() : undefined));
    const controls = [edit, ...children, ...editors].filter(Boolean);
    for (const tool of controls) if (!state.controls.includes(tool)) {
      state.controls.push(tool);
      this.replace(state, tool, 'sitmunCaptureEditingPermission', () => {
        const revision = state.revision;
        return () => revision === state.revision && this.canMutate(state, tool);
      });
      this.setToolInert(tool, !this.canMutate(state));
    }
    for (const target of [...controls, ...controls.map((item) => item.history)].filter(Boolean)) {
      if (state.protected.has(target)) continue;
      state.protected.add(target);
      for (const name of ['activate', 'setData', 'setCoordinates', 'setFeatureCoordinates', 'setStyle', 'setFeature', 'setComplexGeometry',
        'setMode', 'setModes', 'setTextMode', 'setFontColor', 'setFontSize', 'setStrokeColor', 'setFillColor', 'setFillOpacity', 'setStrokeWidth',
        'labelFeatures', 'joinFeatures', 'onRecoverButtonClick', 'removeFeature', 'onDeleteButtonClick',
        'showFeatureImportPanel', 'displayLayerToImport', 'importFeatures', 'importState', 'new', 'end', 'clear', 'cancel', 'resetValues',
        'pushHistory', 'undo', 'redo', 'undoAll', 'canUndo', 'canRedo']) {
        const original = target[name];
        if (typeof original !== 'function') continue;
        const service = this;
        this.replace(state, target, name, function (this: any, ...args: unknown[]) {
          if (name === 'setMode' && (args[0] == null || args[1] === false)) return original.apply(this, args);
          if (!service.canMutate(state, target) && !(state.cleaning && ['clear', 'cancel', 'resetValues'].includes(name))) {
            if (name === 'canUndo' || name === 'canRedo') return false;
            if (name.startsWith('undo') || name === 'redo') return -1;
            return original.constructor.name === 'AsyncFunction' ? Promise.resolve() : undefined;
          }
          return original.apply(this, args);
        });
      }
      for (const name of ['setFeatureAttribute', 'setFeatureData', 'addAttributeElement', 'removeAttributeElement', 'removeFeatureAttribute', 'addFeatureAttributeItem']) {
        const original = target[name];
        if (typeof original === 'function') this.replace(state, target, name, (...args: unknown[]) => {
          if (this.canMutate(state, target)) return original.apply(target, args);
          return original.constructor.name === 'AsyncFunction' ? Promise.resolve() : undefined;
        });
      }
      const setLayer = target.setLayer;
      if (typeof setLayer === 'function') this.replace(state, target, 'setLayer', (...args: any[]) => {
        // Edit.setLayer propagates to its children asynchronously, sometimes
        // after the native WFSEdit promise has completed its preparation.
        if (args[0] == null || this.current(state, state.preparing) && args[0] === state.preparing!.layer ||
            this.canMutate(state) && args[0] === state.active) return setLayer.apply(target, args);
        return undefined;
      });
    }
    if (!Object.getOwnPropertyDescriptor(edit, 'sitmunPermissionModeGuard')) {
      let prototype = Object.getPrototypeOf(edit);
      let descriptor: PropertyDescriptor | undefined;
      while (prototype && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(prototype, 'mode'); prototype = Object.getPrototypeOf(prototype); }
      if (!descriptor?.get || !descriptor.set) throw new Error('WFSEdit mode hook unavailable');
      const native = descriptor;
      Object.defineProperty(edit, 'mode', { configurable: true,
        get: () => native.get!.call(edit),
        set: (mode: unknown) => { if (mode == null || this.canMutate(state)) native.set!.call(edit, mode); }
      });
      this.replace(state, edit, 'sitmunPermissionModeGuard', true);
    }
  }

  private cleanup<T>(state: PermissionState, operation: () => T): T {
    state.cleaning++;
    try {
      const result = operation();
      if (result && typeof (result as any).then === 'function') {
        return Promise.resolve(result).finally(() => { state.cleaning--; }) as T;
      }
      state.cleaning--;
      return result;
    } catch (error) { state.cleaning--; throw error; }
  }

  private freeze(state: PermissionState): void {
    state.active = undefined;
    state.prepared = undefined;
    state.preparing = undefined;
    state.controls.forEach((tool) => this.setToolInert(tool, true));
    const edit = state.control.editControl;
    for (const control of [edit, edit?.modifyControl, edit?.pointDrawControl, edit?.lineDrawControl, edit?.polygonDrawControl]) {
      control?.deactivate?.();
      for (const name of ['selectInteraction', 'modifyInteraction', 'drawInteraction', 'interaction']) control?.wrap?.[name]?.setActive?.(false);
    }
    state.control.sitmunEditingPermissionChanged?.(false);
  }

  private invalidate(state: PermissionState): void {
    state.alive = false;
    this.endSession(state);
  }

  private endSession(state: PermissionState): void {
    state.epoch++;
    state.revision++;
    state.intent = undefined;
    state.changing = undefined;
    state.checking = undefined;
    state.refresh = undefined;
    this.freeze(state);
  }

  private syncCandidates(state: PermissionState): void {
    if (!state.alive) return;
    const selector: HTMLSelectElement | null = state.control.div?.querySelector?.('.tc-ctl-wfsedit-layer-sel');
    const layers = (state.map.workLayers ?? []).filter((layer: any) => this.candidate(state, layer));
    if (selector) {
      for (const option of [...selector.options]) if (option.value && !layers.some((layer: any) => layer.id === option.value)) option.remove();
      for (const layer of layers) if (![...selector.options].some((option) => option.value === layer.id)) {
        selector.add(new Option(layer.title || layer.id, layer.id));
      }
    }
    const host = typeof state.map.div === 'string' ? document.getElementById(state.map.div) : state.map.div;
    for (const button of host?.querySelectorAll?.('.tc-ctl-wfsedit-btn-edit') ?? []) {
      const allowed = this.candidate(state, button.dataset.layerId);
      button.hidden = !allowed;
      button.disabled = !allowed;
    }
  }

  private message(state: PermissionState, key: string): void { state.map.toast?.(this.translate.instant(key)); }

  private setToolInert(tool: any, inert: boolean): void {
    if (tool instanceof HTMLElement) tool.inert = inert;
    if (tool.div instanceof HTMLElement) tool.div.inert = inert;
  }

  private mediate(state: PermissionState, layer: any): void {
    const task = editingTask(state.profile, layer);
    if (!task?.url) throw new Error('Unverified WFS destination');
    const target = new URL(task.url, document.baseURI).href;
    // A non-proxied read layer may be edited only through its backend-issued
    // cartography URL. Keep the existing native serializer/history/transport.
    if (new URL(layer.options?.url ?? layer.url, document.baseURI).href !== target) {
      layer.sitmunLegacyUrl ??= layer.options?.url ?? layer.url;
    }
    layer.url = target;
    layer.options.url = target;
  }

  private async migrateLegacyDrafts(state: PermissionState, store: DraftStore, legacy: string, scoped: string): Promise<boolean> {
    const attempt = state.preparing;
    const current = () => state.preparing === attempt && this.current(state, attempt);
    const belongs = (key: string) => ['added', 'modified', 'removed'].some((operation) => {
      const prefix = `${legacy}.${operation}.`;
      return key.startsWith(prefix) && key.length > prefix.length;
    });
    try {
      const keys = (await store.keys()).filter(belongs);
      if (!current()) return false;
      if (!keys.length) return true;
      // Local pre-deployment drafts are explicitly accepted by the user. Claim once;
      // retain the originals, and never overwrite newer identity-scoped operations.
      if (!navigator.locks) throw new Error('Draft ownership lock unavailable');
      return await navigator.locks.request(`sitmun-wfs-legacy:${legacy}`, async () => {
        if (!current()) return false;
        const selected = (await store.keys()).filter(belongs);
        if (!current()) return false;
        if (!selected.length) return true;
        const ownerKey = `sitmun-wfs-legacy-owner:${legacy}`;
        const record = await store.getItem(ownerKey);
        if (!current()) return false;
        const claim = record && typeof record === 'object'
          ? record as { owner?: unknown; complete?: unknown } : { owner: record, complete: false };
        if ((claim.owner && claim.owner !== scoped) || claim.complete === true) return true;
        if (!claim.owner) await store.setItem(ownerKey, { owner: scoped, complete: false });
        for (const key of selected) {
          if (!current()) return false;
          const target = scoped + key.substring(legacy.length);
          const existing = await store.getItem(target);
          if (!current()) return false;
          if (existing == null) {
            const value = await store.getItem(key);
            if (!current()) return false;
            await store.setItem(target, value);
          }
        }
        if (!current()) return false;
        // Completed claims survive native discard/save so retained originals
        // cannot be replayed as new changes on the next opening.
        await store.setItem(ownerKey, { owner: scoped, complete: true });
        return current();
      });
    } catch {
      if (current()) { this.freeze(state); this.message(state, 'wfsEditing.unavailable'); }
      return false;
    }
  }

  private replace(_state: PermissionState, target: any, name: string, value: unknown): void {
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
  }
}
