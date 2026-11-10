import { ComponentRef, Injectable, OnDestroy, inject } from '@angular/core';
import { NavigationCancel, NavigationError, NavigationSkipped, Router } from '@angular/router';

import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom, Subscription } from 'rxjs';

import { MessageBoxService } from '../../util/message-box-service';
import {
  applyNativeAttributeData, AttributeRegistrationFailure, connectNativeAttributeHistory
} from '../controls/handlers/wfs-attribute-session';
import { FeatureAttributeFormComponent } from '../ui/components/feature-attribute-form/feature-attribute-form.component';
import {
  AttributeData, AttributeFormField, AttributeInput,
  assertAttributeDataSafe, copyAttributeData, mergeAttributeDraft
} from '../utils/feature-attribute-draft';
import { createPatchManager, PatchManager } from '../utils/patch-manager';
import {
  attributeFormFields, isAuxiliaryGmlBounds, isHiddenGmlAttribute, NativeAttributeMetadata, resolveNativeAttributeMetadata
} from '../utils/wfs-attribute-fields';
import {
  parseWfsAttributeSchema,
  loadWfsAttributeSchema,
  resolveWfsFeatureType,
  WfsAttributeSchema
} from '../utils/wfs-attribute-schema';
import { assertWfsAttributeValue, serializeWfsAttributeTransaction } from '../utils/wfs-attribute-transaction';
import {
  MapFeaturePanelMap,
  MapFeaturePanelRef,
  MapFeaturePanelService
} from './map-feature-panel.service';

interface EditingSession {
  changeRevision: number;
  removingLayers?: boolean;
  map: any;
  mapHost: HTMLElement;
  wfsEdit: any;
  editControl: any;
  modifyControl: any;
  attributeEditor: any;
  interaction?: any;
  selectionListener?: (event: any) => void;
  activationTimer?: ReturnType<typeof setTimeout>;
  currentFeature: any | null;
  pendingFeature: any | null;
  currentContextKey: string | null;
  generation: number;
  panelRef?: MapFeaturePanelRef;
  view?: ComponentRef<FeatureAttributeFormComponent>;
  base?: AttributeData;
  fields: AttributeFormField[];
  schema?: WfsAttributeSchema;
  metadata?: NativeAttributeMetadata;
  issues: string[];
  applying: boolean;
  historyRegistrations: number;
  transitioning: boolean;
  registrationFailed: boolean;
  syncing: boolean;
  syncCompleted?: boolean;
  reconciliationFailed?: boolean;
  failedRegistration?: () => Promise<void>;
  failedFeature?: any;
  nativeEditors: any[];
  dirty: boolean;
  acceptedClose: boolean;
  closeScope?: 'session';
  sessionExitApproved?: { layer: any; target: any };
  confirmation?: Promise<boolean>;
  abort: AbortController;
  patches: PatchManager;
}

export interface MapEditingTransition {
  readonly epoch: number;
  readonly revisions: ReadonlyMap<any, number>;
  readonly pending: ReadonlyMap<any, readonly unknown[]>;
  readonly sessions: ReadonlyMap<any, EditingSession>;
  readonly restore: (() => void)[];
  readonly interactions: Set<any>;
  readonly abort: AbortController;
  approved: boolean;
  released: boolean;
  readonly consumed: Set<any>;
}

/** Owns the isolated form draft; native geometry/history/storage stay in WFSEdit. */
@Injectable({ providedIn: 'root' })
export class FeatureAttributeEditingService implements OnDestroy {
  private readonly panels = inject(MapFeaturePanelService);
  private readonly translate = inject(TranslateService, { optional: true });
  private readonly messageBox = inject(MessageBoxService, { optional: true });
  private readonly router = inject(Router, { optional: true });
  private readonly sessions = new Map<any, EditingSession>();
  private readonly connecting = new Map<any, Promise<void>>();
  private readonly connectionRevisions = new WeakMap<HTMLElement, number>();
  private connectionEpoch = 0;
  private destroyed = false;
  private readonly featureKeys = new WeakMap<object, number>();
  private nextFeatureKey = 1;
  private readonly invalidationSub: Subscription;
  private readonly navigationSub?: Subscription;
  private abandoning = false;
  private mapTransition?: MapEditingTransition;
  private navigationTransition?: { id: number; transition: MapEditingTransition; consent: Promise<boolean> };

  isMapTransitionPending(map?: any): boolean {
    const transition = this.mapTransition;
    return !!transition && !transition.released && (!map || transition.sessions.has(map));
  }

  reserveMapTransition(): MapEditingTransition | null {
    if (this.mapTransition || this.abandoning || this.destroyed ||
        [...this.sessions.values()].some((session) => session.confirmation || session.transitioning ||
          session.applying || session.historyRegistrations || session.syncing || session.wfsEdit.isSyncing)) return null;
    const transition: MapEditingTransition = {
      epoch: this.connectionEpoch,
      revisions: new Map([...this.sessions].map(([map, session]) => [map, session.changeRevision])),
      pending: new Map([...this.sessions].map(([map, session]) => [map, this.pendingSnapshot(session)])),
      sessions: new Map(this.sessions), restore: [], interactions: new Set(), abort: new AbortController(),
      consumed: new Set(), approved: false, released: false
    };
    this.mapTransition = transition;
    for (const session of this.sessions.values()) {
      const interactions = new Set<any>([
        session.interaction, session.modifyControl?.wrap?.modifyInteraction,
        ...(session.map.wrap?.map?.getInteractions?.().getArray?.() ?? [])
      ].filter(Boolean));
      for (const interaction of interactions) {
        if (transition.interactions.has(interaction)) continue;
        transition.interactions.add(interaction);
        const active = interaction.getActive?.() !== false;
        interaction.setActive?.(false);
        transition.restore.push(() => {
          if (this.sessions.get(session.map) === session && session.wfsEdit.sitmunCanMutate?.() !== false) interaction.setActive?.(active);
        });
      }
      session.view?.setInput('busy', true);
      session.view?.changeDetectorRef.detectChanges();
      transition.restore.push(() => {
        if (this.sessions.get(session.map) === session) {
          session.view?.setInput('busy', session.applying || session.historyRegistrations > 0 || !!session.confirmation);
          session.view?.changeDetectorRef.detectChanges();
        }
      });
    }
    return transition;
  }

  async authorizeMapTransition(transition: MapEditingTransition): Promise<boolean> {
    if (!this.mapTransitionIsCurrent(transition)) return false;
    const allowed = await this.confirmAbandonment(undefined, transition.abort.signal);
    transition.approved = allowed && this.mapTransitionIsCurrent(transition);
    return transition.approved;
  }

  mapTransitionIsCurrent(transition: MapEditingTransition): boolean {
    return this.mapTransition === transition && !transition.released && !this.destroyed &&
      transition.epoch === this.connectionEpoch && this.sessions.size === transition.sessions.size &&
      [...transition.sessions].every(([map, session]) => {
        const current = this.sessions.get(map);
        if (current !== session || current.changeRevision !== transition.revisions.get(map)) return false;
        const pending = this.pendingSnapshot(current);
        const previous = transition.pending.get(map)!;
        return pending.length === previous.length && pending.every((value, index) => Object.is(value, previous[index]));
      });
  }

  private pendingSnapshot(session: EditingSession): unknown[] {
    const states = [session.wfsEdit.getLayerEditData?.(), ...Object.values(session.wfsEdit.layersEditData ?? {})] as any[];
    return [session.dirty, session.applying, session.historyRegistrations, session.registrationFailed, session.reconciliationFailed, session.syncing,
      session.wfsEdit.isSyncing, ...states.flatMap((state) =>
        ['addedFeaturesLayer', 'modifiedFeaturesLayer', 'removedFeaturesLayer'].flatMap((key) =>
          [key, ...(state?.[key]?.features ?? [])]))];
  }

  /** Synchronous last gate immediately before a route/language listener clears its map. */
  consumeMapTransition(map: any): boolean {
    const transition = this.mapTransition;
    if (!transition) return !this.hasChangesAtRisk(map);
    if (!transition.approved || !this.mapTransitionIsCurrent(transition) || transition.consumed.has(map)) {
      // A late external change must retain an editable old map, not strand it
      // behind a router reservation whose NavigationEnd has already fired.
      if (this.navigationTransition?.transition === transition) this.releaseMapTransition(transition);
      return false;
    }
    transition.consumed.add(map);
    return true;
  }

  releaseMapTransition(transition: MapEditingTransition): void {
    if (transition.released) return;
    transition.released = true;
    if (this.mapTransition !== transition) return;
    this.mapTransition = undefined;
    if (this.navigationTransition?.transition === transition) this.navigationTransition = undefined;
    transition.abort.abort();
    transition.restore.forEach((restore) => restore());
  }

  /** Forced map teardown also cancels a reservation that had no WFSEdit session. */
  invalidateMapTransition(): void {
    if (this.mapTransition) this.releaseMapTransition(this.mapTransition);
  }

  /** A successful guard must retain its lock through async resolvers and reused-route debounce. */
  async confirmNavigationAbandonment(map?: any): Promise<boolean> {
    const id = this.router?.getCurrentNavigation?.()?.id;
    // Non-router callers (e.g. synchronous catalog teardown) retain consent-only semantics.
    if (id === undefined) return this.confirmMapAbandonment(map);
    if (this.navigationTransition?.id === id) return this.navigationTransition.consent;
    const transition = this.reserveMapTransition();
    if (!transition) return false;
    const consent = this.authorizeMapTransition(transition).then((allowed) => {
      if (!allowed || this.router?.getCurrentNavigation?.()?.id !== id) {
        this.releaseMapTransition(transition);
        return false;
      }
      return true;
    }, () => {
      this.releaseMapTransition(transition);
      return false;
    });
    this.navigationTransition = { id, transition, consent };
    return consent;
  }

  /** Catalog preflight: ask once, before any layer in a batch is removed/added. */
  async withLayerRemovalConsent<T>(map: any, layers: readonly any[], operation: () => Promise<T>): Promise<T | undefined> {
    if (this.isMapTransitionPending(map)) return undefined;
    const session = this.sessions.get(map);
    if (!session || !layers.some((layer) => this.isRelatedEditingLayer(session, layer))) return operation();
    if (session.confirmation || session.transitioning || session.applying ||
        session.historyRegistrations || session.syncing || session.wfsEdit.isSyncing) return undefined;
    if (!await this.confirmSessionExit(session) || this.sessions.get(map) !== session) return undefined;
    session.sessionExitApproved = { layer: session.wfsEdit.layer, target: null };
    try {
      session.removingLayers = true;
      await session.wfsEdit.setLayer(null);
      if (session.wfsEdit.layer) return undefined;
      return await operation();
    } catch (error) {
      session.map.toast?.(this.text('featureAttribute.layerCloseFailed'));
      throw error;
    } finally {
      session.removingLayers = false;
      session.sessionExitApproved = undefined;
    }
  }
  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.hasChangesAtRisk()) return;
    event.preventDefault();
    event.returnValue = '';
  };

  constructor() {
    window.addEventListener('beforeunload', this.beforeUnload);
    this.navigationSub = this.router?.events?.subscribe((event) => {
      const navigation = this.navigationTransition;
      if (navigation &&
          (event instanceof NavigationCancel || event instanceof NavigationError || event instanceof NavigationSkipped) &&
          event.id === navigation.id) {
        this.releaseMapTransition(navigation.transition);
      }
      // NavigationEnd deliberately does not unlock: route params may not have
      // reached clearMap yet. Actual map invalidation releases the reservation.
    });
    this.invalidationSub = this.panels.invalidated$.subscribe((host) => {
      if (host === null) this.connectionEpoch++;
      else this.connectionRevisions.set(host, (this.connectionRevisions.get(host) ?? 0) + 1);
      for (const session of [...this.sessions.values()]) {
        if (host === null || host === session.mapHost) this.disconnect(session);
      }
      if (this.mapTransition && (host === null ||
           [...this.mapTransition.sessions.values()].some((session) => session.mapHost === host))) {
        this.releaseMapTransition(this.mapTransition);
      }
    });
  }

  /** Called after the native WFSEdit control has registered on its map. */
  connect(wfsEdit: any, map: any): Promise<void> {
    const current = this.connecting.get(map);
    if (current) return current;
    const pending = this.connectSession(wfsEdit, map).finally(() => {
      if (this.connecting.get(map) === pending) this.connecting.delete(map);
    });
    this.connecting.set(map, pending);
    return pending;
  }

  private async connectSession(wfsEdit: any, map: any): Promise<void> {
    if (this.destroyed || !map?.div || this.sessions.has(map)) return;
    const mapHost =
      typeof map.div === 'string' ? document.getElementById(map.div) : map.div;
    if (!(mapHost instanceof HTMLElement)) return;
    const epoch = this.connectionEpoch;
    // Keep connection cancellation independent of the panel's visual revision:
    // the panel may be reused across sessions, while this map-local counter is
    // advanced only by invalidation events observed by this coordinator.
    const revision = this.connectionRevisions.get(mapHost) ?? 0;
    if (!this.connectionRevisions.has(mapHost)) this.connectionRevisions.set(mapHost, revision);

    const editControl = await wfsEdit.getEditControl();
    const modifyControl = await editControl.getModifyControl();
    const attributeEditor = await editControl.getModifyControlAttributeEditor();
    const editors = [attributeEditor];
    for (const method of ['getPointDrawControlAttributeEditor', 'getLineDrawControlAttributeEditor', 'getPolygonDrawControlAttributeEditor']) {
      if (typeof editControl[method] === 'function') editors.push(await editControl[method]());
    }
    if (this.destroyed || this.connectionEpoch !== epoch ||
        this.connectionRevisions.get(mapHost) !== revision || this.sessions.has(map)) return;
    const session: EditingSession = {
      changeRevision: 0,
      map,
      mapHost,
      wfsEdit,
      editControl,
      modifyControl,
      attributeEditor,
      currentFeature: null,
      pendingFeature: null,
      currentContextKey: null,
      generation: 0,
      dirty: false,
      acceptedClose: false,
      fields: [],
      issues: [],
      applying: false,
      historyRegistrations: 0,
      transitioning: false,
      registrationFailed: false,
      syncing: false,
      nativeEditors: [],
      patches: createPatchManager(),
      abort: new AbortController()
    };
    if (this.mapTransition) this.releaseMapTransition(this.mapTransition);
    this.sessions.set(map, session);
    // Suspend every replaced editor before the first selection or drawing timer.
    for (const editor of editors.filter(Boolean)) {
      session.nativeEditors.push(editor);
      const display = editor.style?.display ?? '';
      const suspended = editor.sitmunAttributesSuspended === true;
      // Forced teardown keeps clients detached, but removes our suspension flag.
      session.patches.add(() => {
        editor.feature = null;
        editor.sitmunAttributesSuspended = suspended;
        if (editor.style) editor.style.display = display;
        // Do not reattach a native client into an invalidated map.
      });
      editor.sitmunAttributesSuspended = true;
      editor.clientControl = null;
      editor.feature = null;
      if (editor.style) editor.style.display = 'none';
    }
    this.watchModifyActivation(session);
    this.attachSelectionInteraction(session);
    this.watchSessionChanges(session);
    this.watchLayerChanges(session);
    this.watchLayerRemovalIntent(session);
    this.watchLayerSelectorIntent(session);
    this.watchLayerVisibilityIntent(session);
    this.watchFormSession(session);
    this.watchExternalControlIntent(session);
  }

  /** Used by FeatureInfo/MIA adapters to suppress late consultation renders. */
  isEditingMap(map: any): boolean {
    const session = this.sessions.get(map);
    return !!session && !!session.wfsEdit.layer && session.editControl?.mode != null;
  }

  /** Includes inactive native layer sessions; cache recovery is not guaranteed. */
  private hasPendingOperations(session: EditingSession): boolean {
    const states = [session.wfsEdit.getLayerEditData?.(),
      ...Object.values(session.wfsEdit.layersEditData ?? {})] as any[];
    return states.some((state) => ['addedFeaturesLayer', 'modifiedFeaturesLayer', 'removedFeaturesLayer']
      .some((key) => (state?.[key]?.features?.length ?? 0) > 0));
  }

  hasChangesAtRisk(map?: any): boolean {
    return [...this.sessions.values()].some((session) => (!map || session.map === map) &&
      (session.dirty || session.applying || session.historyRegistrations > 0 || session.registrationFailed || session.reconciliationFailed || session.syncing ||
        session.wfsEdit.isSyncing || this.hasPendingOperations(session)));
  }

  /** Consent only: do not discard anything until the caller actually leaves. */
  async confirmMapAbandonment(map?: any): Promise<boolean> {
    if (this.isMapTransitionPending(map)) return false;
    return this.confirmAbandonment(map);
  }

  private async confirmAbandonment(map?: any, signal?: AbortSignal): Promise<boolean> {
    const sessions = [...this.sessions.values()].filter((session) => !map || session.map === map);
    if (this.abandoning || sessions.some((session) => session.confirmation || session.transitioning ||
        session.applying || session.historyRegistrations > 0 || session.syncing || session.wfsEdit.isSyncing)) return false;
    const affected = sessions.filter((session) => session.dirty || session.registrationFailed || session.reconciliationFailed ||
      this.hasPendingOperations(session));
    if (!affected.length) return true;
    this.abandoning = true;
    try {
      const allowed = await this.confirmLoss(affected[0], affected.some((session) =>
        session.registrationFailed || session.reconciliationFailed || this.hasPendingOperations(session))
        ? 'featureAttribute.confirmMapMessage' : 'featureAttribute.confirmMessage', false, signal);
      return allowed && affected.every((session) => this.sessions.get(session.map) === session);
    } finally {
      this.abandoning = false;
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.invalidationSub.unsubscribe();
    this.navigationSub?.unsubscribe();
    for (const session of [...this.sessions.values()]) this.disconnect(session);
    if (this.mapTransition) this.releaseMapTransition(this.mapTransition);
  }

  private text(key: string, params?: Record<string, unknown>): string {
    return this.translate?.instant(key, params) ?? key;
  }

  private watchModifyActivation(session: EditingSession): void {
    const control = session.modifyControl;
    if (typeof control?.activate !== 'function') return;
    const originalDescriptor = Object.getOwnPropertyDescriptor(control, 'activate');
    const original = control.activate;
    const service = this;
    const wrapped = function (this: any, ...args: unknown[]): unknown {
      if (service.isMapTransitionPending(session.map)) return undefined;
      const result = original.apply(this, args);
      if (session.activationTimer) clearTimeout(session.activationTimer);
      // Modify.activate creates/replaces its Select interaction asynchronously.
      session.activationTimer = setTimeout(() => {
        session.activationTimer = undefined;
        service.attachSelectionInteraction(session);
      }, 0);
      return result;
    };
    try {
      control.activate = wrapped;
      session.patches.add(() => {
        if (control.activate !== wrapped) return;
        if (originalDescriptor) Object.defineProperty(control, 'activate', originalDescriptor);
        else delete control.activate;
      });
    } catch {
      // The native Modify control remains usable if its method cannot be wrapped.
    }
  }

  private attachSelectionInteraction(session: EditingSession): void {
    const interaction = session.modifyControl?.wrap?.selectInteraction;
    if (!interaction || interaction === session.interaction) return;
    this.detachSelectionInteraction(session);
    const listener = (event: any) => this.onNativeSelection(session, event);
    if (typeof interaction.on !== 'function') return;
    interaction.on('select', listener);
    session.interaction = interaction;
    session.selectionListener = listener;
    const transition = this.mapTransition;
    if (transition && this.isMapTransitionPending(session.map)) {
      for (const native of [interaction, session.modifyControl?.wrap?.modifyInteraction].filter(Boolean)) {
        if (transition.interactions.has(native)) continue;
        transition.interactions.add(native);
        const active = native.getActive?.() !== false;
        native.setActive?.(false);
        transition.restore.push(() => {
          if (this.sessions.get(session.map) === session && session.wfsEdit.sitmunCanMutate?.() !== false) native.setActive?.(active);
        });
      }
    }
  }

  private detachSelectionInteraction(session: EditingSession): void {
    if (session.interaction && session.selectionListener) {
      session.interaction.un?.('select', session.selectionListener);
    }
    session.interaction = undefined;
    session.selectionListener = undefined;
  }

  private onNativeSelection(session: EditingSession, event: any): void {
    if (this.isMapTransitionPending(session.map) || session.confirmation || session.applying || session.transitioning) {
      if (session.currentFeature) this.restoreSelection(session, session.currentFeature);
      return;
    }
    const gesture = event?.mapBrowserEvent;
    if (
      gesture?.type !== 'singleclick' ||
      !gesture.originalEvent ||
      !this.isModifyMode(session)
    ) {
      return;
    }

    const selected = Array.isArray(event.selected) ? event.selected : [];
    if (selected.length === 1) {
      const feature = selected[0]?._wrap?.parent;
      if (feature && this.isFeatureInActiveLayer(session, feature)) {
        void this.showFeature(session, feature);
        return;
      }
    }

    if (selected.length === 0 && (event.deselected?.length ?? 0) === 0) {
      // Clicking an already-selected feature can emit an empty selection delta.
      return;
    }
    if (session.panelRef) void this.closePanel(session, true);
  }

  private isModifyMode(session: EditingSession): boolean {
    return (
      this.isModifyModeWithoutInteraction(session) &&
      session.interaction?.getActive?.() !== false
    );
  }

  private isModifyModeWithoutInteraction(session: EditingSession): boolean {
    return session.wfsEdit.sitmunCanMutate?.() !== false && !!session.wfsEdit.layer && session.editControl?.mode === 'modify' &&
      session.map?.on3DView !== true;
  }

  private isFeatureInActiveLayer(session: EditingSession, feature: any): boolean {
    const editableLayer = session.editControl?.layer ?? session.modifyControl?.layer;
    const logicalLayer = session.wfsEdit?.layer;
    if (!editableLayer || feature.layer !== editableLayer) return false;
    if (Array.isArray(editableLayer.features) && !editableLayer.features.includes(feature)) return false;
    return (
      logicalLayer?.getVisibility?.() !== false &&
      editableLayer.getVisibility?.() !== false
    );
  }

  private async showFeature(session: EditingSession, feature: any): Promise<void> {
    session.sessionExitApproved = undefined;
    const contextKey = this.contextKey(session, feature);
    if (session.currentContextKey === contextKey && session.panelRef?.isCurrent) {
      return;
    }

    const previousFeature = session.currentFeature;
    if (session.dirty && previousFeature) this.restoreSelection(session, previousFeature);
    const generation = ++session.generation;
    session.pendingFeature = feature;

    const layerTitle = String(feature.layer?.title ?? session.wfsEdit.layer?.title ?? 'WFS');
    const identity = feature.id ?? feature.provId ?? '';
    const title = this.text('featureAttribute.title', { layer: layerTitle });
    const closeLabel = this.text('common.button.close');

    let reference: MapFeaturePanelRef | null;
    session.transitioning = true;
    try {
      reference = await this.panels.open(session.map as MapFeaturePanelMap, {
        owner: this,
        contextKey,
        title: identity ? `${title} · ${identity}` : title,
        closeLabel,
        isValid: () =>
          this.sessions.get(session.map) === session &&
          session.generation === generation &&
          this.isModifyMode(session) &&
          this.isFeatureInActiveLayer(session, feature),
        canClose: (reason) => this.allowClose(session, reason),
        mount: (content, ref) => this.mountForm(content, ref, session)
      });
    } catch (error) {
      console.error('[FeatureAttributeEditing] Could not open attribute panel:', error);
      reference = null;
    } finally {
      session.transitioning = false;
    }

    if (this.sessions.get(session.map) !== session) return;
    if (
      !reference ||
      session.generation !== generation
    ) {
      session.pendingFeature = null;
      if (previousFeature) this.restoreSelection(session, previousFeature);
      return;
    }

    session.panelRef = reference;
    session.currentFeature = feature;
    session.currentContextKey = contextKey;
    session.pendingFeature = null;
    session.acceptedClose = false;
    this.restoreSelection(session, feature);
    await this.loadFeatureSchema(session, feature, generation);
  }

  private mountForm(
    content: HTMLElement,
    ref: MapFeaturePanelRef,
    session: EditingSession
  ): () => void {
    const viewCleanup = this.panels.mountComponent(
      content,
      FeatureAttributeFormComponent,
      (component) => {
        session.view = component;
        component.setInput('state', 'loading');
      }
    );
    const retrySub = session.view!.instance.retry.subscribe(() => {
      if (session.currentFeature) {
        void this.loadFeatureSchema(session, session.currentFeature, session.generation);
      }
    });
    const subscriptions = [
      session.view!.instance.dirtyChanged.subscribe((dirty) => { session.dirty = dirty; session.changeRevision++; }),
      session.view!.instance.apply.subscribe((inputs) => { void this.applyDraft(session, inputs); }),
      session.view!.instance.cancel.subscribe(() => { void this.closePanel(session, true); }),
      session.view!.instance.retryRegistration.subscribe(() => { void this.retryRegistration(session); }),
      session.view!.instance.reload.subscribe(() => {
        void this.allowClose(session, 'replace').then((allowed) => {
          if (allowed && session.currentFeature) this.refreshForm(session);
        });
      })
    ];
    ref.closed$.subscribe(() => this.onPanelClosed(session));
    return () => {
      retrySub.unsubscribe();
      subscriptions.forEach((sub) => sub.unsubscribe());
      if (session.view?.location.nativeElement.parentElement === content) {
        session.view = undefined;
      }
      viewCleanup();
    };
  }

  private async loadFeatureSchema(
    session: EditingSession,
    feature: any,
    generation: number
  ): Promise<void> {
    const view = session.view;
    if (!view || !session.panelRef?.isCurrent) return;
    this.updateView(session, { state: 'loading', fields: [], issues: [] });

    try {
      const layer = feature.layer;
      const context = {
        featureType: Array.isArray(layer.featureType) ? [...layer.featureType] : [layer.featureType],
        featureNS: layer.featureNS,
        options: { featureNS: layer.options?.featureNS }
      };
      const serviceUrl = layer.url ?? layer.options?.url;
      const [loaded, metadataResult] = await Promise.all([
        loadWfsAttributeSchema(layer),
        this.loadNativeMetadata(layer).then(
          (metadata) => ({ metadata, error: null as unknown }),
          (error: unknown) => ({ metadata: null, error })
        )
      ]);
      if (!this.isCurrent(session, feature, generation)) return;
      const currentTypes = Array.isArray(layer.featureType) ? layer.featureType : [layer.featureType];
      if (feature.layer !== layer || serviceUrl !== (layer.url ?? layer.options?.url) ||
          currentTypes.length !== context.featureType.length ||
          currentTypes.some((name: string, index: number) => name !== context.featureType[index]) ||
          layer.featureNS !== context.featureNS || layer.options?.featureNS !== context.options.featureNS) {
        throw new Error('WFS layer context changed while DescribeFeatureType was loading');
      }
      const featureType = resolveWfsFeatureType(context, loaded.documents, loaded.capabilities);
      const schema = parseWfsAttributeSchema(
        loaded.documents,
        featureType,
        loaded.issues
      );
      const issues = [...schema.issues];
      if (metadataResult.error) {
        issues.push('Native layer metadata could not be read; fields remain read-only');
      }
      const metadata = resolveNativeAttributeMetadata(schema, metadataResult.metadata, featureType);
      const fields = this.toViewFields(
        schema,
        feature,
        metadata,
        issues.length > 0
      );
      session.schema = schema;
      // A declared data property named id is distinct from the external WFS fid.
      // This is layer evidence, independent of the selected feature's key alias.
      const dataIds = schema.fields.filter((field) => field.name === 'id');
      this.replaceMember(session, layer, 'sitmunHasDataId', dataIds.length === 1 && fields.some((field) =>
        field.schema?.name === 'id' && field.schema.namespace === dataIds[0].namespace));
      this.replaceMember(session, layer, 'sitmunSerializeAttributeTransaction',
        (transaction: Element, inserts: Parameters<typeof serializeWfsAttributeTransaction>[1],
          updates: Parameters<typeof serializeWfsAttributeTransaction>[2]) =>
          serializeWfsAttributeTransaction(transaction, inserts, updates, schema));
      session.metadata = metadata;
      session.issues = issues;
      session.fields = fields;
      try { session.base = copyAttributeData(feature.getData?.() ?? feature.data ?? {}); }
      catch { session.base = undefined; issues.push(this.text('featureAttribute.unsafeData')); }
      this.updateView(session, { state: 'ready', fields, issues });
      if (session.registrationFailed) session.view?.setInput('error', 'registrationFailed');
      this.updatePending(session);
    } catch (error) {
      if (!this.isCurrent(session, feature, generation)) return;
      this.updateView(session, {
        state: 'error',
        fields: [],
        issues: [error instanceof Error ? error.message : 'WFS schema loading failed']
      });
    }
  }

  private async loadNativeMetadata(layer: any): Promise<NativeAttributeMetadata | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => layer.getFeatureTypeMetadata?.()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Native metadata request deadline exceeded')), 5000);
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private toViewFields(
    schema: WfsAttributeSchema,
    feature: any,
    metadata: NativeAttributeMetadata | undefined,
    schemaHasIssues: boolean
  ): AttributeFormField[] {
    return attributeFormFields(schema, feature.getData?.() ?? feature.data ?? {}, metadata,
      schemaHasIssues, (key) => this.text(key), !!feature.provId);
  }

  private updateView(
    session: EditingSession,
    update: {
      state: 'loading' | 'ready' | 'error';
      fields: AttributeFormField[];
      issues: string[];
    }
  ): void {
    const view = session.view;
    if (!view || !session.panelRef?.isCurrent) return;
    session.panelRef.update(() => {
      view.setInput('state', update.state);
      view.setInput('fields', update.fields);
      view.setInput('issues', update.issues);
      view.changeDetectorRef.detectChanges();
    });
  }

  private refreshForm(session: EditingSession): void {
    if (!session.currentFeature || !session.schema) return;
    try {
      session.base = copyAttributeData(session.currentFeature.getData());
      session.fields = this.toViewFields(session.schema, session.currentFeature,
        session.metadata, session.issues.length > 0);
      session.view?.setInput('error', '');
      session.view?.setInput('conflictNames', []);
      this.updateView(session, { state: 'ready', fields: session.fields, issues: session.issues });
    } catch {
      session.view?.setInput('error', 'unsafeData');
    }
    this.updatePending(session);
  }

  private updatePending(session: EditingSession): void {
    const data = session.wfsEdit.getLayerEditData?.();
    const pending = ['addedFeaturesLayer', 'modifiedFeaturesLayer', 'removedFeaturesLayer']
      .some((name) => (data?.[name]?.features?.length ?? 0) > 0);
    session.view?.setInput('pending', pending);
    session.view?.setInput('syncing', session.syncing || session.wfsEdit.isSyncing === true);
  }

  private async applyDraft(
    session: EditingSession,
    inputs: ReadonlyMap<string, AttributeInput>
  ): Promise<void> {
    const feature = session.currentFeature;
    if (!feature || session.wfsEdit.sitmunCanMutate?.() === false || this.isMapTransitionPending(session.map) || session.applying || session.historyRegistrations > 0 || session.confirmation) return;
    const generation = session.generation;
    const view = session.view;
    view?.setInput('error', '');
    try {
      if (!this.isCurrent(session, feature, generation) || !session.base || !session.schema ||
           session.syncing || session.wfsEdit.isSyncing || session.registrationFailed || session.reconciliationFailed || session.issues.length ||
          session.wfsEdit.sitmunAttributeRegistrationVersion !== 1 ||
          session.nativeEditors.some((editor) => editor.sitmunAttributeIsolationVersion !== 1) ||
          session.wfsEdit.getLayerEditData?.()?.serializable !== true ||
          !session.editControl.history?.setData) throw new Error('unverified');
      const current = feature.getData();
      const schema = session.schema;
      assertAttributeDataSafe(current);
      // Reject live properties added after the form snapshot; never silently
      // drop session data or confuse hidden GML infrastructure with a new field.
      if (Object.keys(current).some((name) => !isHiddenGmlAttribute(schema, name) &&
          !session.fields.some((field) => field.name === name && field.schema))) {
        throw new Error('unverified');
      }
      const merged = mergeAttributeDraft(session.base, current, inputs, session.fields);
      // Never hand structures to an installation whose serializer still coerces
      // objects/arrays to text. Check the proposal too, including new properties.
      if ((Object.entries(merged.data).some(([name, value]) => value !== null && typeof value === 'object' &&
          !isAuxiliaryGmlBounds(schema, name, value)) || session.fields.some((field) => field.schema?.type === 'list')) &&
          feature.layer.wrap?.sitmunAttributeTransactionVersion !== 1) throw new Error('unverified');
      for (const value of Object.values(merged.delta)) assertWfsAttributeValue(value, schema);
      if (merged.conflicts.length) {
        view?.setInput('conflictNames', merged.conflicts);
        throw new Error('conflict');
      }
      if (!Object.keys(merged.delta).length) {
        this.refreshForm(session);
        return;
      }
      session.applying = true;
      view?.setInput('busy', true);
      await applyNativeAttributeData(session.editControl, feature, merged.data);
      if (this.isCurrent(session, feature, generation)) this.refreshForm(session);
    } catch (error) {
      if (session.applying) session.registrationFailed = true;
      if (error instanceof AttributeRegistrationFailure) {
        session.failedRegistration = error.retry;
        session.failedFeature = feature;
      }
      if (this.sessions.get(session.map) === session && session.currentFeature === feature) {
        const key = error instanceof Error ? error.message : '';
        view?.setInput('error', ['unverified', 'conflict', 'unsafeData', 'invalidValue'].includes(key)
          ? key : 'registrationFailed');
      }
    } finally {
      session.applying = false;
      if (this.sessions.get(session.map) === session && session.view === view) {
        view?.setInput('busy', false);
        view?.changeDetectorRef.detectChanges();
      }
    }
  }

  private async retryRegistration(session: EditingSession): Promise<void> {
    const retry = session.failedRegistration;
    const feature = session.failedFeature;
    if (!retry || !feature || session.wfsEdit.sitmunCanMutate?.() === false || this.isMapTransitionPending(session.map) || session.applying || !this.isFeatureInActiveLayer(session, feature)) return;
    session.applying = true;
    const view = session.view;
    view?.setInput('busy', true);
    try {
      await retry();
      if (this.sessions.get(session.map) !== session) return;
      session.registrationFailed = false;
      session.failedRegistration = undefined;
      session.failedFeature = undefined;
      if (session.currentFeature === feature) session.base = copyAttributeData(feature.getData());
      // Preserve the draft, including any edits made since the failed Apply.
      // The next Apply compares it to the now-acknowledged session base.
      view?.setInput('error', '');
      this.updatePending(session);
    } catch (error) {
      if (error instanceof AttributeRegistrationFailure) session.failedRegistration = error.retry;
    } finally {
      session.applying = false;
      if (this.sessions.get(session.map) === session && session.view === view) view?.setInput('busy', false);
    }
  }

  private watchFormSession(session: EditingSession): void {
    this.replaceMember(session, session.wfsEdit, 'sitmunEditingPermissionChanged', (allowed: boolean) => {
      session.view?.setInput('permissionDenied', !allowed);
      session.view?.changeDetectorRef.detectChanges();
    });
    const canSave = () => {
      if (session.wfsEdit.sitmunCanMutate?.() === false) return false;
      if (this.isMapTransitionPending(session.map)) return false;
      if (session.reconciliationFailed) {
        session.map.toast?.(this.text('featureAttribute.saveReconcileFailed'));
        return false;
      }
      if (session.syncing || session.wfsEdit.isSyncing || session.confirmation || session.transitioning || session.historyRegistrations > 0) return false;
      if (!session.dirty && !session.applying && !session.registrationFailed) return true;
      session.map.toast?.(this.text(session.registrationFailed
        ? 'featureAttribute.registrationFailed' : 'featureAttribute.resolveDraft'));
      return false;
    };
    this.replaceMember(session, session.wfsEdit, 'sitmunCanSaveAttributes', canSave);
    this.replaceMember(session, session.wfsEdit, 'sitmunAttributeSyncState', (state: string) => {
      if (this.sessions.get(session.map) !== session) return;
      session.syncing = state === 'saving';
      session.syncCompleted = state === 'success';
      session.reconciliationFailed = state === 'reconcileError';
      session.view?.setInput('syncing', session.syncing);
      session.view?.setInput('error', state === 'error' ? 'saveFailed' :
        state === 'reconcileError' ? 'saveReconcileFailed' : '');
      this.updatePending(session);
      session.view?.changeDetectorRef.detectChanges();
    });
    // Also protects installations pending postinstall, and programmatic callers.
    if (typeof session.wfsEdit.applyEdits === 'function') {
      const original = session.wfsEdit.applyEdits;
      this.replaceMember(session, session.wfsEdit, 'applyEdits', function (this: any, ...args: unknown[]) {
        if (!canSave()) return Promise.resolve();
        return original.apply(this, args);
      });
    }
    const history = session.editControl.history;
    const service = this;
    // Native programmatic geometry/attribute entry points, before they mutate data.
    for (const target of [history, session.editControl, session.modifyControl,
      session.editControl.pointDrawControl, session.editControl.lineDrawControl, session.editControl.polygonDrawControl]) {
      if (!target) continue;
      for (const name of ['setData', 'setCoordinates', 'setStyle', 'removeFeature', 'activate', 'setComplexGeometry',
        'new', 'end', 'undo', 'redo', 'clear', 'cancel', 'setFeature', 'importState']) {
        const original = target[name];
        if (typeof original !== 'function') continue;
        this.replaceMember(session, target, name, function (this: any, ...args: unknown[]) {
          if (service.isMapTransitionPending(session.map)) return original.constructor.name === 'AsyncFunction' ? Promise.resolve() : undefined;
          return original.apply(this, args);
        });
      }
    }
    if (history?.addEventListener) {
      let undoingAll = false;
      for (const name of ['undo', 'redo', 'undoAll']) {
        const original = history[name];
        if (typeof original !== 'function') continue;
        this.replaceMember(session, history, name, function (this: any, ...args: unknown[]) {
          if (service.isMapTransitionPending(session.map)) return -1;
          if (session.applying || (!undoingAll && session.historyRegistrations > 0) || session.confirmation || session.syncing || session.wfsEdit.isSyncing) return -1;
          if (name !== 'undoAll') return original.apply(this, args);
          // Native undoAll loops on canUndo(). Its own nested undo calls must
          // make progress even though the first action started async storage.
          undoingAll = true;
          try { return original.apply(this, args); }
          finally { undoingAll = false; }
        });
      }
      session.patches.add(connectNativeAttributeHistory(session.editControl, (feature, error) => {
        if (this.sessions.get(session.map) !== session) return;
        if (error) {
          session.registrationFailed = true;
          if (error instanceof AttributeRegistrationFailure) {
            session.failedRegistration = error.retry;
            session.failedFeature = feature;
          }
          session.view?.setInput('error', 'registrationFailed');
        } else if (feature === session.currentFeature && !session.dirty) {
          this.refreshForm(session);
        }
        this.updatePending(session);
      }, (pending) => {
        if (this.sessions.get(session.map) !== session) return;
        session.changeRevision++;
        session.historyRegistrations += pending ? 1 : -1;
        session.view?.setInput('busy', this.isMapTransitionPending(session.map) || session.applying || session.historyRegistrations > 0);
      }));
    }
    const changed = (event: any) => {
      session.changeRevision++;
      if (this.isMapTransitionPending(session.map)) return;
      if (event.feature !== session.currentFeature || event.geometryChanged === true || event.historyAction || session.applying) return;
      // A dirty draft is deliberately left untouched. Three-way merge checks it on Apply.
      if (!session.dirty) this.refreshForm(session);
    };
    session.editControl.on?.('featuremodify.tc', changed);
    session.patches.add(() => session.editControl.off?.('featuremodify.tc', changed));
    const externalChange = () => { session.changeRevision++; };
    const changeEvents = 'featureadd.tc featuresadd.tc featureremove.tc featuresclear.tc featuremodify.tc layeradd.tc layerremove.tc';
    session.map.on?.(changeEvents, externalChange);
    session.patches.add(() => session.map.off?.(changeEvents, externalChange));
    this.watchModeIntent(session);
    this.watchDestructiveSessionIntent(session);
    const blockPendingGesture = (event: Event) => {
      if (!this.isMapTransitionPending(session.map) && !session.applying && !session.historyRegistrations && !session.confirmation && !session.syncing && !session.wfsEdit.isSyncing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'change']) {
      session.mapHost.addEventListener(type, blockPendingGesture, true);
      session.patches.add(() => session.mapHost.removeEventListener(type, blockPendingGesture, true));
    }
  }

  private replaceMember(session: EditingSession, target: any, name: string, value: unknown): void {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
    session.patches.add(() => {
      if (target[name] !== value) return;
      if (previous) Object.defineProperty(target, name, previous);
      else delete target[name];
    });
  }

  private async confirmSessionExit(session: EditingSession): Promise<boolean> {
    if (this.isMapTransitionPending(session.map)) return false;
    if (session.applying || session.syncing || session.wfsEdit.isSyncing || session.confirmation || session.transitioning) return false;
    session.closeScope = 'session';
    try {
      if (session.panelRef) return await this.closePanel(session, true);
      if (!session.registrationFailed && !this.hasPendingOperations(session)) return true;
      return await this.confirmLoss(session, 'featureAttribute.confirmSessionMessage', false);
    } finally {
      session.closeScope = undefined;
    }
  }

  /** Guard exclusive tools before their native activation deactivates Modify. */
  private watchExternalControlIntent(session: EditingSession): void {
    const watched = new WeakSet<object>();
    const watch = (control: any) => {
      if (!control || watched.has(control) || typeof control.activate !== 'function' ||
          [session.wfsEdit, session.editControl, session.modifyControl,
            session.editControl.pointDrawControl, session.editControl.lineDrawControl,
            session.editControl.polygonDrawControl].includes(control)) return;
      watched.add(control);
      const original = control.activate;
      const asynchronous = original.constructor.name === 'AsyncFunction';
      const service = this;
      this.replaceMember(session, control, 'activate', function (this: any, ...args: unknown[]) {
        if (service.isMapTransitionPending(session.map)) return asynchronous ? Promise.resolve() : undefined;
        if (!session.panelRef) return original.apply(this, args);
        if (session.confirmation || session.applying || session.transitioning || session.syncing) {
          return asynchronous ? Promise.resolve() : undefined;
        }
        const activation = service.closePanel(session, true).then((closed) => {
          if (closed && service.sessions.get(session.map) === session) return original.apply(this, args);
          return undefined;
        });
        // Native Control/Click activation is void; async tools retain a promise.
        if (asynchronous) return activation;
        void activation.catch((error) => console.error('[FeatureAttributeEditing] Tool activation failed:', error));
        return undefined;
      });
    };
    (session.map.controls ?? []).forEach(watch);
    const added = (event: any) => watch(event.control);
    session.map.on?.('controladd.tc', added);
    session.patches.add(() => session.map.off?.('controladd.tc', added));
  }

  private watchDestructiveSessionIntent(session: EditingSession): void {
    const control = session.wfsEdit;
    if (typeof control.discardEdits === 'function') {
      const original = control.discardEdits;
      this.replaceMember(session, control, 'sitmunDiscardAttributes', () => {
        if (!session.panelRef && !session.registrationFailed && !this.hasPendingOperations(session)) return false;
        control.discardEdits();
        return true;
      });
      const service = this;
      this.replaceMember(session, control, 'discardEdits', function (this: any, ...args: unknown[]): unknown {
        if (service.isMapTransitionPending(session.map)) return undefined;
        if (session.syncCompleted) {
          session.syncCompleted = false;
          return original.apply(this, args);
        }
        if (session.syncing || control.isSyncing) return undefined;
        if (session.confirmation || session.applying || session.transitioning) return undefined;
        void service.confirmSessionExit(session).then((closed) => {
          if (closed && service.sessions.get(session.map) === session) {
            session.registrationFailed = false;
            session.failedRegistration = undefined;
            session.failedFeature = undefined;
            original.apply(this, args);
          }
        });
        return undefined; // Native discardEdits is a synchronous void method.
      });
    }
    const modify = session.modifyControl;
    if (typeof modify.onDeleteButtonClick === 'function') {
      const original = modify.onDeleteButtonClick;
      const service = this;
      this.replaceMember(session, modify, 'onDeleteButtonClick', function (this: any, ...args: unknown[]): unknown {
        if (service.isMapTransitionPending(session.map)) return this;
        if (!session.panelRef) return original.apply(this, args);
        if (session.confirmation || session.applying || session.transitioning) return this;
        const selected = [...(this.getSelectedFeatures?.() ?? [])];
        void service.closePanel(session, true).then((closed) => {
          if (closed && service.sessions.get(session.map) === session) {
            this.setSelectedFeatures(selected);
            original.apply(this, args);
          }
        });
        return this;
      });
    }
  }

  private watchModeIntent(session: EditingSession): void {
    const edit = session.editControl;
    const own = Object.getOwnPropertyDescriptor(edit, 'mode');
    let prototype = Object.getPrototypeOf(edit);
    let descriptor: PropertyDescriptor | undefined = own;
    while (prototype && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, 'mode');
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!descriptor?.get || !descriptor.set) return;
    const native = descriptor;
    const setter = (mode: unknown) => {
      const permissionCurrent = edit.sitmunCaptureEditingPermission?.();
      if (this.isMapTransitionPending(session.map)) return;
      if (!session.panelRef || mode === native.get!.call(edit)) {
        native.set!.call(edit, mode);
        return;
      }
      if (session.confirmation || session.applying) return;
      const currentMode = native.get!.call(edit);
      // Native sitna-tab updates its own selected/target state before its
      // callback assigns Edit.mode. Restore that UI while the guard decides.
      const group = `${edit.getId?.()}-mode`;
      for (const tab of Array.from(edit.querySelectorAll?.('sitna-tab[group]') ?? []) as any[]) {
        if (tab.getAttribute('group') === group) {
          tab.selected = tab.getAttribute('for') === `${group}-${currentMode}`;
        }
      }
      void this.closePanel(session, true).then((closed) => {
        if (closed && this.sessions.get(session.map) === session && permissionCurrent?.() !== false) native.set!.call(edit, mode);
      });
    };
    Object.defineProperty(edit, 'mode', { configurable: true, get: () => native.get!.call(edit), set: setter });
    session.patches.add(() => {
      if (Object.getOwnPropertyDescriptor(edit, 'mode')?.set !== setter) return;
      if (own) Object.defineProperty(edit, 'mode', own);
      else delete edit.mode;
    });
  }

  private isCurrent(
    session: EditingSession,
    feature: any,
    generation: number
  ): boolean {
    return (
      this.sessions.get(session.map) === session &&
      session.generation === generation &&
      session.currentFeature === feature &&
      session.panelRef?.isCurrent === true &&
      this.isModifyMode(session) &&
      this.isFeatureInActiveLayer(session, feature)
    );
  }

  private contextKey(session: EditingSession, feature: any): string {
    const layer = feature.layer;
    const identity = feature.id ?? feature.provId;
    if (identity !== undefined && identity !== null) {
      return `${layer?.id ?? ''}/${String(identity)}`;
    }
    let key = this.featureKeys.get(feature);
    if (!key) {
      key = this.nextFeatureKey++;
      this.featureKeys.set(feature, key);
    }
    return `${layer?.id ?? ''}/session-${key}`;
  }

  private async allowClose(
    session: EditingSession,
    _reason: 'close' | 'replace'
  ): Promise<boolean> {
    if (this.isMapTransitionPending(session.map)) return false;
    if (session.applying || session.historyRegistrations > 0 || session.syncing || session.wfsEdit.isSyncing) return false;
    if (!session.dirty && !(session.closeScope === 'session' &&
        (session.registrationFailed || this.hasPendingOperations(session)))) {
      session.acceptedClose = true;
      return true;
    }
    return this.confirmLoss(session, session.closeScope === 'session'
      ? 'featureAttribute.confirmSessionMessage' : 'featureAttribute.confirmMessage', true);
  }

  private confirmLoss(session: EditingSession, message: string, discardDraft: boolean, signal?: AbortSignal): Promise<boolean> {
    if (!this.messageBox) return Promise.resolve(false);
    if (session.confirmation) return session.confirmation;
    const transitionManaged = !!signal;
    const interactions = (transitionManaged ? [] : [session.interaction, session.modifyControl?.wrap?.modifyInteraction])
      .filter(Boolean).map((interaction) => ({ interaction, active: interaction.getActive?.() !== false }));
    interactions.forEach(({ interaction }) => interaction.setActive?.(false));
    session.view?.setInput('busy', true);
    const confirmation = firstValueFrom(
      this.messageBox.confirm(
        this.text('featureAttribute.confirmTitle'),
        this.text(message),
        {
          cancelLabel: this.text('featureAttribute.continueEditing'),
          confirmLabel: this.text('featureAttribute.discard'),
          destructive: true,
          signal: signal ?? session.abort.signal
        }
      )
    )
      .then((confirmed) => {
        const allowed = confirmed === true && this.sessions.get(session.map) === session;
        if (discardDraft) {
          session.acceptedClose = allowed;
          if (allowed) session.dirty = false;
        }
        return allowed;
      })
      .catch(() => {
        session.acceptedClose = false;
        return false;
      })
      .finally(() => {
        if (!this.isMapTransitionPending(session.map) && this.sessions.get(session.map) === session && this.isModifyModeWithoutInteraction(session)) {
          interactions.forEach(({ interaction, active }) => interaction.setActive?.(active));
        }
        if (!this.isMapTransitionPending(session.map) && this.sessions.get(session.map) === session) session.view?.setInput('busy', false);
        if (session.confirmation === confirmation) session.confirmation = undefined;
      });
    session.confirmation = confirmation;
    return confirmation;
  }

  private onPanelClosed(session: EditingSession): void {
    session.panelRef = undefined;
    if (session.pendingFeature) return;
    if (!session.acceptedClose) return; // Forced map/auth cleanup.
    session.acceptedClose = false;
    session.currentFeature = null;
    session.currentContextKey = null;
    session.dirty = false;
    session.base = undefined;
    session.fields = [];
    session.generation++;
    this.clearNativeSelection(session);
  }

  private async closePanel(session: EditingSession, restoreOnCancel: boolean): Promise<boolean> {
    const ref = session.panelRef;
    if (!ref) return true;
    if (session.transitioning || session.applying) return false;
    session.transitioning = true;
    try {
      const closed = await ref.requestClose();
      if (!closed && restoreOnCancel && session.currentFeature && this.sessions.get(session.map) === session) {
        this.restoreSelection(session, session.currentFeature);
      }
      return closed;
    } finally {
      session.transitioning = false;
    }
  }

  private clearNativeSelection(session: EditingSession): void {
    try {
      session.editControl?.setSelectedFeatures?.([]);
    } catch {
      // The map may already be invalid during a forced teardown.
    }
  }

  private restoreSelection(session: EditingSession, feature: any): void {
    try {
      session.editControl?.setSelectedFeatures?.([feature]);
      if (session.attributeEditor) session.attributeEditor.feature = null;
    } catch {
      // A changed/destroyed native selection is not a usable restore target.
    }
  }

  private watchSessionChanges(session: EditingSession): void {
    if (typeof session.map?.on !== 'function') return;
    const listener = (event: any) => {
      const hiddenLayer = event?.layer;
      if (
        hiddenLayer &&
        this.isRelatedEditingLayer(session, hiddenLayer) &&
        hiddenLayer.getVisibility?.() === false
      ) {
        void this.closePanel(session, true);
        return;
      }
      if (session.panelRef) {
        setTimeout(() => {
          if (session.panelRef && !this.isModifyMode(session)) {
            void this.closePanel(session, true);
          }
        }, 0);
      }
    };
    session.map.on(
      'controlactivate.tc controldeactivate.tc layervisibility.tc layervisibility',
      listener
    );
    session.patches.add(() =>
      session.map.off?.(
        'controlactivate.tc controldeactivate.tc layervisibility.tc layervisibility',
        listener
      )
    );
  }

  private watchLayerChanges(session: EditingSession): void {
    const control = session.wfsEdit;
    if (typeof control?.setLayer !== 'function') return;
    const originalDescriptor = Object.getOwnPropertyDescriptor(control, 'setLayer');
    const original = control.setLayer;
    const service = this;
    const transition = function (this: any, target: unknown, ...args: unknown[]): unknown {
      if (service.isMapTransitionPending(session.map)) return Promise.resolve(session.wfsEdit.layer);
      const nextLayer = typeof target === 'string' ? session.map.getLayer?.(target) : target;
      const permissionCurrent = target != null ? control.sitmunCaptureLayerAttempt?.(nextLayer) : undefined;
      const consent = session.sessionExitApproved;
      session.sessionExitApproved = undefined;
      if (consent && consent.layer === this.layer &&
          (consent.target === target || consent.target === nextLayer || consent.target === nextLayer?.id)) {
        return original.call(this, target, ...args);
      }
      if (session.registrationFailed || session.applying || session.confirmation || session.syncing || this.isSyncing) {
        session.map.toast?.(service.text('featureAttribute.registrationFailed'));
        return Promise.resolve(session.wfsEdit.layer);
      }
      if (nextLayer === this.layer || !session.panelRef && !service.hasPendingOperations(session)) {
        return original.call(this, target, ...args);
      }
      return service.confirmSessionExit(session).then((closed) => {
        if (!closed || permissionCurrent?.() === false) return session.wfsEdit.layer;
        return original.call(this, target, ...args);
      });
    };
    // Permission must precede consent, not sit underneath this instance wrapper.
    const wrapped = function (this: any, target: unknown, ...args: unknown[]): unknown {
      const operation = () => Promise.resolve(transition.call(this, target, ...args));
      return target != null && typeof control.sitmunWithLayerPermission === 'function'
        ? control.sitmunWithLayerPermission(target, operation) : operation();
    };
    try {
      control.setLayer = wrapped;
      session.patches.add(() => {
        if (control.setLayer !== wrapped) return;
        if (originalDescriptor) Object.defineProperty(control, 'setLayer', originalDescriptor);
        else delete control.setLayer;
      });
    } catch {
      // Keep the native layer selector intact if the instance is not patchable.
    }
  }

  /**
   * WFSEdit handles LAYERREMOVE after SITNA has removed the layer. Its native
   * close path then cannot resolve the editable layer and leaves the old
   * session active. Finish the guarded transition before the physical removal.
   */
  private watchLayerRemovalIntent(session: EditingSession): void {
    const map = session.map;
    if (typeof map?.removeLayer !== 'function') return;
    const originalDescriptor = Object.getOwnPropertyDescriptor(map, 'removeLayer');
    const original = map.removeLayer;
    const service = this;
    let closingForRemoval = false;
    const wrapped = async function (this: any, target: any, ...args: unknown[]): Promise<unknown> {
      if (service.isMapTransitionPending(session.map)) return target;
      const layer = typeof target === 'string' ? map.getLayer?.(target) : target;
      if (!service.isRelatedEditingLayer(session, layer) || session.removingLayers ||
          (layer?.owner || layer?.options?.owner || layer?.options?.stealth) && layer !== session.wfsEdit.layer ||
          closingForRemoval ||
          service.sessions.get(session.map) !== session) {
        return original.call(this, target, ...args);
      }
      if (session.confirmation || session.applying || session.transitioning) return target;

      const closed = await service.confirmSessionExit(session);
      if (!closed || service.sessions.get(session.map) !== session) return target;
      try {
        // Clear WFSEdit while the logical/editable layer still belongs to map.
        // Its own close path may remove an associated editable helper layer.
        closingForRemoval = true;
        session.sessionExitApproved = { layer: session.wfsEdit.layer, target: null };
        await session.wfsEdit.setLayer(null);
        if (session.wfsEdit.layer) return target;
      } catch (error) {
        session.map.toast?.(service.text('featureAttribute.layerCloseFailed'));
        console.error('[FeatureAttributeEditing] Could not close WFSEdit before layer removal:', error);
        return target;
      } finally {
        closingForRemoval = false;
        session.sessionExitApproved = undefined;
      }
      return original.call(this, target, ...args);
    };
    try {
      map.removeLayer = wrapped;
      session.patches.add(() => {
        if (map.removeLayer !== wrapped) return;
        if (originalDescriptor) Object.defineProperty(map, 'removeLayer', originalDescriptor);
        else delete map.removeLayer;
      });
    } catch {
      // Preserve native behavior when the map method cannot be patched.
    }
  }

  private watchLayerVisibilityIntent(session: EditingSession): void {
    const listener = (event: Event) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('sitna-toggle.tc-ctl-wlm-cb-visibility')
        : null;
      if (!target || !session.mapHost.contains(target)) return;
      const row = target?.closest<HTMLElement>('li.tc-ctl-wlm-elm[data-layer-id]');
      const layerId = row?.dataset['layerId'];
      const layer = layerId ? session.map.getLayer?.(layerId) : undefined;
      if (!target || !layer || !this.isRelatedEditingLayer(session, layer)) return;

      const intendedVisible = Boolean((target as HTMLElement & { checked?: boolean }).checked);
      const currentlyVisible = layer.getVisibility?.() !== false;
      if (!currentlyVisible || intendedVisible) return;

      // Intercept before WorkLayerManager's bubbling change handler mutates the layer.
      event.preventDefault();
      event.stopImmediatePropagation();
      this.setToggleChecked(target, currentlyVisible);
      if (session.confirmation || session.applying || session.transitioning) return;
      void this.closePanel(session, true).then((closed) => {
        if (closed) layer.setVisibility(false);
        else this.setToggleChecked(target, currentlyVisible);
      });
    };
    document.addEventListener('change', listener, true);
    session.patches.add(() => document.removeEventListener('change', listener, true));
  }

  private watchLayerSelectorIntent(session: EditingSession): void {
    // The mandatory native hook owns preflight -> setLayer/consent -> open.
    if (typeof session.wfsEdit.sitmunChangeEditingLayer === 'function') return;
    let replaying = false;
    const listener = (event: Event) => {
      const selector = event.target;
      if (replaying || !(selector instanceof HTMLSelectElement) ||
          !selector.matches('.tc-ctl-wfsedit-layer-sel') || !session.mapHost.contains(selector)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const targetValue = selector.value;
      const previousLayer = session.wfsEdit.layer;
      selector.value = previousLayer?.id ?? '';
      if (session.confirmation || session.applying || session.transitioning || session.registrationFailed) return;
      void this.confirmSessionExit(session).then((closed) => {
        if (!closed || this.sessions.get(session.map) !== session || session.wfsEdit.layer !== previousLayer) return;
        selector.value = targetValue;
        // Replay exactly once through the existing native change handler, only
        // after consent; even its preliminary #setEditState(false) is deferred.
        replaying = true;
        session.sessionExitApproved = { layer: previousLayer, target: targetValue || null };
        try { selector.dispatchEvent(new Event('change', { bubbles: true })); }
        // The native listener resolves getEditableLayer asynchronously before
        // setLayer consumes this one-shot consent. Opening another form clears it.
        finally { replaying = false; }
      });
    };
    document.addEventListener('change', listener, true);
    session.patches.add(() => document.removeEventListener('change', listener, true));
  }

  private setToggleChecked(target: HTMLElement, checked: boolean): void {
    const toggle = target as HTMLElement & { checked?: boolean };
    if (typeof toggle.checked === 'boolean') toggle.checked = checked;
    target.toggleAttribute('checked', checked);
  }

  private isRelatedEditingLayer(session: EditingSession, layer: any): boolean {
    const logical = session.wfsEdit?.layer;
    const editable = session.editControl?.layer ?? session.modifyControl?.layer;
    const related = [logical, logical?.wfsLayer, logical?.wmsLayer, editable, editable?.wmsLayer];
    return related.some((candidate) => candidate === layer);
  }

  private disconnect(session: EditingSession): void {
    if (this.sessions.get(session.map) !== session) return;
    this.sessions.delete(session.map);
    session.abort.abort();
    session.generation++;
    if (session.activationTimer) clearTimeout(session.activationTimer);
    this.detachSelectionInteraction(session);
    session.patches.restoreAll();
    // Forced map/auth invalidation does not restore controls into a dead map.
    session.view = undefined;
    session.panelRef = undefined;
    session.currentFeature = null;
    session.pendingFeature = null;
  }
}
