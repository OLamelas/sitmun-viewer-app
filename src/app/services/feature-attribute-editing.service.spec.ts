import { DebugElement, getDebugNode } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationSkipped, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { FeatureAttributeEditingService } from './feature-attribute-editing.service';
import { LanguageService } from './language.service';
import { MapFeaturePanelService } from './map-feature-panel.service';
import { MessageBoxService } from '../../util/message-box-service';
import { FeatureAttributeFormComponent } from '../ui/components/feature-attribute-form/feature-attribute-form.component';
import { NativeAttributeMetadata } from '../utils/wfs-attribute-fields';

describe('FeatureAttributeEditingService', () => {
  let service: FeatureAttributeEditingService;
  let interaction: { on: jest.Mock; un: jest.Mock; getActive: jest.Mock };
  let panels: { invalidated$: Subject<HTMLElement | null>; open: jest.Mock };

  beforeEach(() => {
    interaction = {
      on: jest.fn(),
      un: jest.fn(),
      getActive: jest.fn().mockReturnValue(true)
    };
    panels = {
      invalidated$: new Subject<HTMLElement | null>(),
      open: jest.fn().mockResolvedValue({ isCurrent: true, requestClose: jest.fn() })
    };
    TestBed.configureTestingModule({
      providers: [
        FeatureAttributeEditingService,
        { provide: MapFeaturePanelService, useValue: panels },
        { provide: TranslateService, useValue: { instant: (key: string) => key } },
        { provide: MessageBoxService, useValue: { confirm: jest.fn() } }
      ]
    });
    service = TestBed.inject(FeatureAttributeEditingService);
  });

  afterEach(() => service.ngOnDestroy());

  it('opens only from a native singleclick selection, not programmatic selection events', async () => {
    const editableLayer = { id: 'editable', title: 'Layer', getVisibility: () => true };
    const logicalLayer = { id: 'logical', getVisibility: () => true };
    const map = {
      div: document.createElement('div'),
      on3DView: false,
      on: jest.fn(),
      off: jest.fn()
    };
    const modifyControl = {
      layer: editableLayer,
      activate: jest.fn(),
      wrap: { selectInteraction: interaction }
    };
    const attributeEditor = {
      clientControl: modifyControl,
      feature: null,
      style: { display: '' }
    };
    const editControl = {
      layer: editableLayer,
      mode: 'modify',
      getModifyControl: jest.fn().mockResolvedValue(modifyControl),
      getModifyControlAttributeEditor: jest.fn().mockResolvedValue(attributeEditor),
      setSelectedFeatures: jest.fn()
    };
    const wfsEdit = {
      layer: logicalLayer,
      getEditControl: jest.fn().mockResolvedValue(editControl)
    };

    await service.connect(wfsEdit, map);
    const listener = interaction.on.mock.calls[0][1] as (event: unknown) => void;
    const feature = { id: 'feature-1', layer: editableLayer, getData: () => ({ label: 'A' }) };

    listener({ selected: [{ _wrap: { parent: feature } }], deselected: [], mapBrowserEvent: undefined });
    listener({
      selected: [{ _wrap: { parent: feature } }],
      deselected: [],
      mapBrowserEvent: { type: 'click', originalEvent: new MouseEvent('click') }
    });
    await Promise.resolve();

    expect(panels.open).not.toHaveBeenCalled();

    listener({
      selected: [{ _wrap: { parent: feature } }],
      deselected: [],
      mapBrowserEvent: { type: 'singleclick', originalEvent: new MouseEvent('click') }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(panels.open).toHaveBeenCalledTimes(1);
    expect(panels.open.mock.calls[0][1].contextKey).toBe('editable/feature-1');
    expect(panels.open.mock.calls[0][1].owner).toBe(service);
  });

  it('does not open the phase-2 panel from 3D selection or when Modify is inactive', async () => {
    const editableLayer = { id: 'editable', getVisibility: () => true };
    const map = { div: document.createElement('div'), on3DView: true, on: jest.fn(), off: jest.fn() };
    const modifyControl = { layer: editableLayer, activate: jest.fn(), wrap: { selectInteraction: interaction } };
    const editControl = {
      layer: editableLayer,
      mode: 'modify',
      getModifyControl: jest.fn().mockResolvedValue(modifyControl),
      getModifyControlAttributeEditor: jest.fn().mockResolvedValue({ clientControl: modifyControl, style: {} })
    };
    await service.connect({ layer: editableLayer, getEditControl: async () => editControl }, map);

    const listener = interaction.on.mock.calls[0][1] as (event: unknown) => void;
    const feature = { id: 'feature-2', layer: editableLayer };
    listener({
      selected: [{ _wrap: { parent: feature } }],
      deselected: [],
      mapBrowserEvent: { type: 'singleclick', originalEvent: new MouseEvent('click') }
    });
    map.on3DView = false;
    interaction.getActive.mockReturnValue(false);
    listener({
      selected: [{ _wrap: { parent: feature } }],
      deselected: [],
      mapBrowserEvent: { type: 'singleclick', originalEvent: new MouseEvent('click') }
    });

    expect(panels.open).not.toHaveBeenCalled();
  });
});

describe('phase 3 form/session coordination', () => {
  let service: FeatureAttributeEditingService;
  let panels: MapFeaturePanelService;
  let host: HTMLElement;
  let interaction: any;
  let edit: any;
  let modify: any;
  let wfs: any;
  let map: any;
  let layer: any;
  let a: any;
  let b: any;
  let answer: Subject<boolean>;
  let confirm: jest.Mock;
  let setData: jest.Mock;
  let routerEvents: Subject<unknown>;
  let navigation: { id: number } | null;

  beforeEach(() => {
    answer = new Subject<boolean>();
    routerEvents = new Subject();
    navigation = null;
    confirm = jest.fn(() => answer.asObservable());
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [FeatureAttributeEditingService, MapFeaturePanelService,
        { provide: Router, useValue: { events: routerEvents, getCurrentNavigation: () => navigation } },
        { provide: MessageBoxService, useValue: { confirm } }]
    });
    service = TestBed.inject(FeatureAttributeEditingService);
    panels = TestBed.inject(MapFeaturePanelService);
    host = document.createElement('div');
    document.body.append(host);
    let active = true;
    interaction = { on: jest.fn(), un: jest.fn(), getActive: () => active,
      setActive: jest.fn((value: boolean) => { active = value; }) };
    const xml = new DOMParser().parseFromString(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema"
      xmlns:a="urn:a" targetNamespace="urn:a"><x:element name="items"><x:complexType><x:sequence>
      <x:element name="label" type="x:string"/></x:sequence></x:complexType></x:element></x:schema>`, 'text/xml');
    layer = { id: 'editable', featureType: 'a:items', getVisibility: () => true,
      getCapabilitiesPromise: async () => ({}), getDescribeFeatureTypeUrl: () => 'https://wfs.test/schema',
      proxificationTool: { fetchXML: async () => xml },
      getFeatureTypeMetadata: async () => ({ attributes: [{ name: 'label' }], geometries: [] }) };
    a = { id: 'a', layer, getData: () => ({ label: 'A' }) };
    b = { id: 'b', layer, getData: () => ({ label: 'B' }) };
    const nativeEditor = { clientControl: {}, style: { display: '' }, feature: null, sitmunAttributeIsolationVersion: 1 };
    modify = { activate: jest.fn(), wrap: { selectInteraction: interaction } };
    setData = jest.fn();
    edit = { mode: 'modify', layer, getModifyControl: async () => modify,
      getModifyControlAttributeEditor: async () => nativeEditor, setSelectedFeatures: jest.fn(),
      on: jest.fn(), off: jest.fn(), history: { setData } };
    wfs = { layer, getEditControl: async () => edit, applyEdits: jest.fn().mockResolvedValue(undefined),
      discardEdits: jest.fn(),
      getLayerEditData: () => ({ serializable: true, modifiedFeaturesLayer: { features: [] } }) };
    map = { div: host, on: jest.fn(), off: jest.fn(), getLayer: () => layer, toast: jest.fn() };
  });
  afterEach(() => { panels.destroyAll(); service.ngOnDestroy(); host.remove(); });

  async function settle(): Promise<void> {
    // Yield one task so all currently queued promise continuations finish, without
    // guessing their nesting depth or waiting for a pending confirmation/registration.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  async function click(feature: any, deselected: any[] = []): Promise<void> {
    interaction.on.mock.calls[0][1]({ selected: feature ? [{ _wrap: { parent: feature } }] : [],
      deselected, mapBrowserEvent: { type: 'singleclick', originalEvent: new MouseEvent('click') } });
    await settle();
  }
  function form(): FeatureAttributeFormComponent {
    return (getDebugNode(host.querySelector('app-feature-attribute-form')!) as DebugElement).componentInstance;
  }
  async function open(): Promise<void> {
    await service.connect(wfs, map);
    expect(interaction.on).toHaveBeenCalledTimes(1);
    await click(a);
  }

  it('bounds native metadata loading and handles synchronous metadata failures', async () => {
    jest.useFakeTimers();
    try {
      layer.getFeatureTypeMetadata = () => new Promise(() => undefined);
      const result = service['loadNativeMetadata'](layer);
      const rejected = expect(result).rejects.toThrow('deadline exceeded');
      await jest.advanceTimersByTimeAsync(5000);
      await rejected;
      layer.getFeatureTypeMetadata = () => { throw new Error('metadata unavailable'); };
      await expect(service['loadNativeMetadata'](layer)).rejects.toThrow('metadata unavailable');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps selection/draft on rejected A→B and ignores further clicks while confirming', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    await click(b, [a]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(edit.setSelectedFeatures).toHaveBeenLastCalledWith([a]);
    await click(b, [a]);
    expect(confirm).toHaveBeenCalledTimes(1);
    answer.next(false);
    await settle();
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(interaction.getActive()).toBe(true);
    expect(setData).not.toHaveBeenCalled();
  });

  it('loads a native WMS-associated short type without changing the layer or attributes', async () => {
    layer.featureType = ['items'];
    layer.options = { featureNS: 'a' };
    await open();
    expect(form().rows[0].group.controls.text.value).toBe('A');
    expect(layer.featureType).toEqual(['items']);
    expect(a.getData()).toEqual({ label: 'A' });
    expect(setData).not.toHaveBeenCalled();
  });

  it('ignores a late DescribeFeatureType response from selection A after B', async () => {
    const xml = await layer.proxificationTool.fetchXML();
    let resolveA!: (value: Document) => void;
    layer.proxificationTool.fetchXML = jest.fn()
      .mockImplementationOnce(() => new Promise<Document>((resolve) => { resolveA = resolve; }))
      .mockResolvedValue(xml);
    await service.connect(wfs, map);
    await click(a);
    await click(b, [a]);
    expect(form().rows[0].group.controls.text.value).toBe('B');
    resolveA(xml);
    await settle();
    expect(form().rows[0].group.controls.text.value).toBe('B');
  });

  it('reserves a clean map before language loading and blocks native/programmatic editing until release', async () => {
    const setCoordinates = jest.fn();
    const undo = jest.fn();
    edit.history = Object.assign(new EventTarget(), { setData: jest.fn(), setCoordinates, undo });
    await open();
    const transition = service.reserveMapTransition()!;
    expect(transition).not.toBeNull();
    expect(await service.authorizeMapTransition(transition)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(interaction.getActive()).toBe(false);
    expect(form().busy).toBe(true);
    edit.history.setCoordinates(a, []);
    edit.history.undo(a);
    await wfs.applyEdits();
    await click(b, [a]);
    expect(setCoordinates).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(form().rows[0].group.controls.text.value).toBe('A');
    expect(service.reserveMapTransition()).toBeNull();
    expect(service.consumeMapTransition(map)).toBe(true);
    expect(service.consumeMapTransition(map)).toBe(false);
    service.releaseMapTransition(transition);
    service.releaseMapTransition(transition);
    expect(interaction.getActive()).toBe(true);
    expect(form().busy).toBe(false);
  });

  it('retains the draft through language consent and never unlocks when the dialog closes', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    const transition = service.reserveMapTransition()!;
    const consent = service.authorizeMapTransition(transition);
    answer.next(true);
    expect(await consent).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(form().busy).toBe(true);
    expect(interaction.getActive()).toBe(false);
    service.releaseMapTransition(transition);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(interaction.getActive()).toBe(true);
  });

  it('keeps the real route reservation after NavigationEnd until the debounced map is destroyed', async () => {
    const nativeSetData = jest.fn();
    edit.history = Object.assign(new EventTarget(), { setData: nativeSetData });
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    navigation = { id: 1 };
    const consent = service.confirmNavigationAbandonment(map);
    answer.next(true);
    expect(await consent).toBe(true);
    routerEvents.next(new NavigationEnd(1, '/map/3/4', '/map/3/4'));
    navigation = null;
    await settle();
    expect(service.isMapTransitionPending(map)).toBe(true);
    expect(interaction.getActive()).toBe(false);
    expect(form().busy).toBe(true);
    edit.history.setData(a, { label: 'too late' });
    form().submit(new Event('submit'));
    expect(nativeSetData).not.toHaveBeenCalled();
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(service.consumeMapTransition(map)).toBe(true);
    panels.destroyMap(host);
    expect(service.isMapTransitionPending()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    new NavigationCancel(1, '/map/3/4', 'another guard refused'),
    new NavigationError(1, '/map/3/4', new Error('resolver failed')),
    new NavigationSkipped(1, '/map/3/4', 'navigation skipped')
  ])('restores editing and retains the draft after $constructor.name', async (event) => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    navigation = { id: 1 };
    const consent = service.confirmNavigationAbandonment(map);
    const sameNavigation = service.confirmNavigationAbandonment(map);
    answer.next(true);
    expect(await consent).toBe(true);
    expect(await sameNavigation).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    routerEvents.next(event);
    expect(service.isMapTransitionPending(map)).toBe(false);
    expect(interaction.getActive()).toBe(true);
    expect(form().busy).toBe(false);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
  });

  it('releases a refused route reservation without changing the map or draft', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    navigation = { id: 1 };
    const consent = service.confirmNavigationAbandonment(map);
    answer.next(false);
    expect(await consent).toBe(false);
    expect(service.isMapTransitionPending()).toBe(false);
    expect(interaction.getActive()).toBe(true);
    expect(form().busy).toBe(false);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
  });

  it('cancels a pending route confirmation when Angular cancels that navigation', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    confirm.mockImplementation((_title: string, _message: string, options: any) => {
      options.signal.addEventListener('abort', () => answer.next(false), { once: true });
      return answer;
    });
    navigation = { id: 1 };
    const consent = service.confirmNavigationAbandonment(map);
    routerEvents.next(new NavigationCancel(1, '/map/3/4', 'superseded'));
    navigation = { id: 2 };
    expect(await consent).toBe(false);
    expect(service.isMapTransitionPending()).toBe(false);
    expect(form().busy).toBe(false);
    expect(interaction.getActive()).toBe(true);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
  });

  it('does not unlock an already committed map transition when a second navigation is rejected', async () => {
    await open();
    navigation = { id: 1 };
    expect(await service.confirmNavigationAbandonment(map)).toBe(true);
    routerEvents.next(new NavigationEnd(1, '/map/3/4', '/map/3/4'));
    navigation = { id: 2 };
    expect(await service.confirmNavigationAbandonment(map)).toBe(false);
    routerEvents.next(new NavigationCancel(2, '/map/5/6', 'transition already pending'));
    expect(service.isMapTransitionPending(map)).toBe(true);
    expect(interaction.getActive()).toBe(false);
    panels.destroyMap(host);
    expect(service.isMapTransitionPending()).toBe(false);
  });

  it('rejects route consent if the guarded state changes before approval', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    navigation = { id: 1 };
    const consent = service.confirmNavigationAbandonment(map);
    wfs.layersEditData = { other: { addedFeaturesLayer: { features: [b] } } };
    answer.next(true);
    expect(await consent).toBe(false);
    expect(service.isMapTransitionPending()).toBe(false);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
  });

  it('retains an editable old map if an external change invalidates consent after NavigationEnd', async () => {
    await open();
    navigation = { id: 1 };
    expect(await service.confirmNavigationAbandonment(map)).toBe(true);
    routerEvents.next(new NavigationEnd(1, '/map/3/4', '/map/3/4'));
    navigation = null;
    wfs.layersEditData = { other: { addedFeaturesLayer: { features: [b] } } };
    expect(service.consumeMapTransition(map)).toBe(false);
    expect(service.isMapTransitionPending()).toBe(false);
    expect(interaction.getActive()).toBe(true);
    expect(form().rows[0].group.controls.text.value).toBe('A');
    expect(service.hasChangesAtRisk(map)).toBe(true);
  });

  it('rejects language cancellation and preserves draft and session', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    const transition = service.reserveMapTransition()!;
    const consent = service.authorizeMapTransition(transition);
    answer.next(false);
    expect(await consent).toBe(false);
    service.releaseMapTransition(transition);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(service.consumeMapTransition(map)).toBe(false);
  });

  it('cancels a pending language dialog on release without leaving controls locked', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    confirm.mockImplementation((_title: string, _message: string, options: any) => {
      options.signal.addEventListener('abort', () => answer.next(false), { once: true });
      return answer;
    });
    const transition = service.reserveMapTransition()!;
    const consent = service.authorizeMapTransition(transition);
    service.releaseMapTransition(transition);
    expect(await consent).toBe(false);
    expect(interaction.getActive()).toBe(true);
    expect(form().busy).toBe(false);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
  });

  it('invalidates prior language consent on an unexpected external modification', async () => {
    await open();
    const transition = service.reserveMapTransition()!;
    expect(await service.authorizeMapTransition(transition)).toBe(true);
    const changed = map.on.mock.calls.find(([events]: [string]) => events.includes('featuresadd.tc'))[1];
    changed({ feature: a });
    expect(service.mapTransitionIsCurrent(transition)).toBe(false);
    expect(service.consumeMapTransition(map)).toBe(false);
    service.releaseMapTransition(transition);
  });

  it('rechecks native pending operations even if an external writer emits no event', async () => {
    await open();
    const transition = service.reserveMapTransition()!;
    expect(await service.authorizeMapTransition(transition)).toBe(true);
    wfs.layersEditData = { other: { addedFeaturesLayer: { features: [b] } } };
    expect(service.consumeMapTransition(map)).toBe(false);
    service.releaseMapTransition(transition);
  });

  it('immediately invalidates a language reservation on forced auth/map cleanup', async () => {
    await open();
    const transition = service.reserveMapTransition()!;
    expect(await service.authorizeMapTransition(transition)).toBe(true);
    panels.destroyAll();
    expect(service.isMapTransitionPending()).toBe(false);
    expect(service.mapTransitionIsCurrent(transition)).toBe(false);
    expect(service.hasChangesAtRisk()).toBe(false);
    service.releaseMapTransition(transition);
  });

  it('holds the real language/coordinator lock through a deferred translation until authorized teardown', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    const translate = TestBed.inject(TranslateService);
    translate.currentLang = 'en';
    const translation = new Subject<object>();
    jest.spyOn(translate, 'getTranslation').mockReturnValue(translation);
    const language = TestBed.runInInjectionContext(() => new LanguageService(
      {} as any, {} as any, translate, { isLoggedIn: () => false } as any, {} as any
    ));
    let cleared = false;
    const listener = translate.onLangChange.subscribe(() => {
      expect(service.consumeMapTransition(map)).toBe(true);
      expect(service.isMapTransitionPending(map)).toBe(true);
      panels.destroyMap(host);
      cleared = true;
    });
    const subscription = language.setLanguage('ca', false).subscribe();
    answer.next(true);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(form().busy).toBe(true);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(interaction.getActive()).toBe(false);
    expect(translate.currentLang).toBe('en');
    expect(cleared).toBe(false);
    // Model the real loader's cache write before it emits to the consumer.
    translate.setTranslation('ca', {});
    translation.next({});
    expect(cleared).toBe(true);
    expect(translate.currentLang).toBe('ca');
    expect(service.isMapTransitionPending()).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    subscription.unsubscribe();
    listener.unsubscribe();
    localStorage.removeItem('language');
  });

  it('discards only the draft on an accepted A→B and shows B without applying', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    await click(b, [a]);
    answer.next(true);
    await settle();
    expect(form().rows[0].group.controls.text.value).toBe('B');
    expect(edit.setSelectedFeatures).toHaveBeenLastCalledWith([b]);
    expect(setData).not.toHaveBeenCalled();
  });

  it('closes WFSEdit before removing the old layer and can open the next layer form', async () => {
    const openPanel = jest.spyOn(panels, 'open');
    const removeLayer = jest.fn(async (target: any) => target);
    map.removeLayer = removeLayer;
    const setLayer = jest.fn(async (target: any) => {
      wfs.layer = target;
      edit.layer = target;
      modify.layer = target;
      return target;
    });
    wfs.setLayer = setLayer;
    await open();
    expect(host.querySelector('app-feature-attribute-form')).not.toBeNull();

    await map.removeLayer(layer);
    expect(setLayer).toHaveBeenCalledWith(null);
    expect(wfs.layer).toBeNull();
    expect(removeLayer).toHaveBeenCalledWith(layer);
    expect(host.querySelector('app-feature-attribute-form')).toBeNull();

    const nextLayer = { ...layer, id: 'next-editable' };
    const nextFeature = { id: 'next-feature', layer: nextLayer, getData: () => ({ label: 'Next' }) };
    nextLayer.getCapabilitiesPromise = layer.getCapabilitiesPromise;
    nextLayer.getDescribeFeatureTypeUrl = layer.getDescribeFeatureTypeUrl;
    nextLayer.proxificationTool = layer.proxificationTool;
    nextLayer.getFeatureTypeMetadata = layer.getFeatureTypeMetadata;
    map.getLayer = (id: string) => id === nextLayer.id ? nextLayer : null;
    await wfs.setLayer(nextLayer);
    await click(nextFeature);

    expect(form().rows[0].group.controls.text.value).toBe('Next');
    expect(openPanel).toHaveBeenCalledTimes(2);
  });

  it('blocks native save with a draft, but allows it again after manually reverting', async () => {
    const save = wfs.applyEdits;
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    expect(wfs.sitmunCanSaveAttributes()).toBe(false);
    void wfs.applyEdits();
    await settle();
    expect(save).not.toHaveBeenCalled();
    form().rows[0].group.controls.text.setValue('A');
    void wfs.applyEdits();
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Cancel confirms, closes and deselects, without discarding applied session operations', async () => {
    const operations = [{ id: 'already-applied' }];
    wfs.getLayerEditData = () => ({ modifiedFeaturesLayer: { features: operations } });
    await open();
    const original = form();
    expect(original.pending).toBe(true);
    original.rows[0].group.controls.text.setValue('draft');
    original.cancel.emit();
    await settle();
    answer.next(true);
    await settle();
    expect(host.querySelector('app-feature-attribute-form')).toBeNull();
    expect(edit.setSelectedFeatures).toHaveBeenLastCalledWith([]);
    expect(operations).toEqual([{ id: 'already-applied' }]);
  });

  it('applies valid changes through native history without a verification bypass', async () => {
    let data = { label: 'A' };
    a.getData = () => data;
    wfs.sitmunAttributeRegistrationVersion = 1;
    setData.mockImplementation((_feature: unknown, next: { label: string }) => {
      const oldData = data;
      data = { ...next };
      return { type: 'attributesChange', oldData, newData: data };
    });
    edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(Promise.resolve()));
    await open();
    const component = form();
    component.rows[0].group.controls.text.setValue('draft');
    component.submit(new Event('submit'));
    await settle();
    expect(component.error).toBe('');
    expect(component.dirty).toBe(false);
    expect(data).toEqual({ label: 'draft' });
    expect(setData).toHaveBeenCalledTimes(1);
    expect(edit.trigger).toHaveBeenCalledTimes(1);
  });

  it('asks before abandoning a draft, retaining it even after consent until teardown actually happens', async () => {
    const discard = wfs.discardEdits;
    await open();
    const component = form();
    component.rows[0].group.controls.text.setValue('draft');
    const leaving = service.confirmMapAbandonment(map);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await service.confirmMapAbandonment(map)).toBe(false);
    answer.next(false);
    expect(await leaving).toBe(false);
    expect(component.dirty).toBe(true);
    expect(component.rows[0].group.controls.text.value).toBe('draft');
    const allowed = service.confirmMapAbandonment(map);
    answer.next(true);
    expect(await allowed).toBe(true);
    // A later route guard may still reject navigation: consent is not discard.
    expect(component.dirty).toBe(true);
    expect(service.hasChangesAtRisk(map)).toBe(true);
    expect(setData).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it('protects inactive native sessions with no open form and uses the browser unload guard', async () => {
    await service.connect(wfs, map);
    expect(service.hasChangesAtRisk(map)).toBe(false);
    wfs.layersEditData = { previous: { addedFeaturesLayer: { features: [{ provId: 'new' }] } } };
    wfs.layer = null;
    expect(service.hasChangesAtRisk(map)).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const leaving = service.confirmMapAbandonment(map);
    expect(confirm.mock.calls[0][1]).toBe('featureAttribute.confirmMapMessage');
    answer.next(false);
    expect(await leaving).toBe(false);
    panels.destroyMap(map);
    expect(service.hasChangesAtRisk(map)).toBe(false);
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it('keeps the form and operations recoverable after a real save failure, not its early return', async () => {
    const operations = [a];
    wfs.getLayerEditData = () => ({ modifiedFeaturesLayer: { features: operations } });
    await open();
    const component = form();
    wfs.isSyncing = true;
    wfs.sitmunAttributeSyncState('saving');
    expect(component.syncing).toBe(true);
    expect(await service.confirmMapAbandonment(map)).toBe(false);
    expect(wfs.sitmunCanSaveAttributes()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    wfs.isSyncing = false;
    wfs.sitmunAttributeSyncState('error');
    expect(form()).toBe(component);
    expect(component.syncing).toBe(false);
    expect(component.error).toBe('saveFailed');
    expect(component.pending).toBe(true);
    expect(operations).toEqual([a]);
    expect(wfs.sitmunCanSaveAttributes()).toBe(true);
    wfs.sitmunAttributeSyncState('reconcileError');
    expect(component.error).toBe('saveReconcileFailed');
    expect(wfs.sitmunCanSaveAttributes()).toBe(false);
  });

  it('does not ask a second discard question for successful native save cleanup', async () => {
    const discard = wfs.discardEdits;
    wfs.getLayerEditData = () => ({ modifiedFeaturesLayer: { features: [a] } });
    await open();
    wfs.sitmunAttributeSyncState('success');
    wfs.discardEdits();
    await settle();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('guards an external tool before its native activation can deactivate Modify', async () => {
    const activate = jest.fn();
    const tool = { activate };
    map.controls = [tool];
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    expect(tool.activate()).toBeUndefined();
    await settle();
    expect(activate).not.toHaveBeenCalled();
    answer.next(false);
    await settle();
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    tool.activate();
    await settle();
    answer.next(true);
    await settle();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('lets native undoAll make progress while guarding its asynchronous attribute registrations', async () => {
    let remaining = 2;
    let acknowledge!: () => void;
    const storage = new Promise<void>((resolve) => { acknowledge = resolve; });
    const history = Object.assign(new EventTarget(), { setData: jest.fn(),
      undo: jest.fn(() => {
        remaining--;
        const event = Object.assign(new Event('undo'), { feature: a,
          action: { type: 'attributesChange', oldData: { label: 'A' }, newData: { label: 'B' } } });
        history.dispatchEvent(event);
      }),
      undoAll() {
        let iterations = 0;
        while (remaining > 0) {
          if (++iterations > 2) throw new Error('Native undoAll stopped making progress');
          this.undo();
        }
      }
    });
    edit.history = history;
    edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(storage));
    await open();
    history.undoAll();
    expect(remaining).toBe(0);
    expect(wfs.sitmunCanSaveAttributes()).toBe(false);
    expect(await service.confirmMapAbandonment(map)).toBe(false);
    acknowledge();
    await settle();
    expect(wfs.sitmunCanSaveAttributes()).toBe(true);
  });

  it('protects a session switch with applied operations even after closing the clean form', async () => {
    const setLayer = jest.fn(async (target: any) => { wfs.layer = target; return target; });
    wfs.setLayer = setLayer;
    wfs.getLayerEditData = () => ({ modifiedFeaturesLayer: { features: [a] } });
    await open();
    form().cancel.emit();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    const changing = wfs.setLayer(null);
    await settle();
    expect(setLayer).not.toHaveBeenCalled();
    answer.next(false);
    await changing;
    expect(wfs.layer).toBe(layer);
    expect(setLayer).not.toHaveBeenCalled();
  });

  it('intercepts visibility before mutation and preserves the toggle on cancellation', async () => {
    await open();
    layer.setVisibility = jest.fn();
    form().rows[0].group.controls.text.setValue('draft');
    const row = document.createElement('li');
    row.className = 'tc-ctl-wlm-elm';
    row.dataset['layerId'] = layer.id;
    const toggle = document.createElement('sitna-toggle');
    toggle.className = 'tc-ctl-wlm-cb-visibility';
    Object.assign(toggle, { checked: false });
    row.append(toggle);
    host.append(row);
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(layer.setVisibility).not.toHaveBeenCalled();
    answer.next(false);
    await settle();
    expect((toggle as HTMLElement & { checked: boolean }).checked).toBe(true);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    Object.assign(toggle, { checked: false });
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    answer.next(true);
    await settle();
    expect(layer.setVisibility).toHaveBeenCalledTimes(1);
    expect(layer.setVisibility).toHaveBeenCalledWith(false);
  });

  it('guards the native mode setter before changing tools, without changing its synchronous contract', async () => {
    let mode = 'modify';
    const nativeSet = jest.fn((value: string) => { mode = value; });
    const prototype = Object.create(Object.getPrototypeOf(edit));
    Object.defineProperty(prototype, 'mode', { configurable: true, get: () => mode, set: nativeSet });
    delete edit.mode;
    Object.setPrototypeOf(edit, prototype);
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    edit.mode = 'addpoint';
    await settle();
    expect(nativeSet).not.toHaveBeenCalled();
    answer.next(false);
    await settle();
    expect(edit.mode).toBe('modify');
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    edit.mode = 'addpoint';
    await settle();
    answer.next(true);
    await settle();
    expect(nativeSet).toHaveBeenCalledTimes(1);
    expect(edit.mode).toBe('addpoint');
  });

  it('composes the own permission descriptor and cannot revive a mode after deferred consent', async () => {
    let mode = 'modify'; let allowed = true; let revision = 1;
    const nativeSet = jest.fn((value: string) => { mode = value; });
    const prototype = Object.create(Object.getPrototypeOf(edit));
    Object.defineProperty(prototype, 'mode', { configurable: true, get: () => mode, set: nativeSet });
    Object.setPrototypeOf(edit, prototype);
    const guardedSet = jest.fn((value: string) => { if (allowed) nativeSet(value); });
    Object.defineProperty(edit, 'mode', { configurable: true, get: () => mode, set: guardedSet });
    edit.sitmunCaptureEditingPermission = () => {
      const captured = revision; return () => allowed && captured === revision;
    };
    await open(); form().rows[0].group.controls.text.setValue('draft');
    edit.mode = 'addpoint'; await settle();
    allowed = false; revision++;
    answer.next(true); await settle();
    expect(nativeSet).not.toHaveBeenCalled(); expect(mode).toBe('modify');
    allowed = true;
    edit.mode = 'addpoint'; await settle();
    expect(guardedSet).toHaveBeenCalled(); expect(nativeSet).toHaveBeenCalledTimes(1);
    service.ngOnDestroy();
    expect(Object.getOwnPropertyDescriptor(edit, 'mode')?.set).toBe(guardedSet);
    allowed = false; edit.mode = 'modify'; expect(nativeSet).toHaveBeenCalledTimes(1);
  });

  it('does not call setLayer when a close invalidates an already pending layer consent', async () => {
    let revision = 1;
    const nativeSet = jest.fn(async (target: any) => { wfs.layer = target; return target; });
    wfs.setLayer = nativeSet;
    wfs.sitmunCaptureLayerAttempt = () => { const captured = revision; return () => captured === revision; };
    await open(); form().rows[0].group.controls.text.setValue('draft');
    const switching = wfs.setLayer({ ...layer, id: 'next' }); await settle();
    expect(confirm).toHaveBeenCalled(); revision++;
    answer.next(true); await switching;
    expect(nativeSet).not.toHaveBeenCalled(); expect(wfs.layer).toBe(layer);
  });

  it('intercepts the native layer selector before even its preliminary UI mutation', async () => {
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    const selector = document.createElement('select');
    selector.className = 'tc-ctl-wfsedit-layer-sel';
    for (const id of [layer.id, 'other']) {
      const option = document.createElement('option'); option.value = id; selector.append(option);
    }
    host.append(selector);
    const nativeChange = jest.fn();
    selector.addEventListener('change', nativeChange);
    selector.value = 'other';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(nativeChange).not.toHaveBeenCalled();
    answer.next(false);
    await settle();
    expect(selector.value).toBe(layer.id);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    selector.value = 'other';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    answer.next(true);
    await settle();
    expect(nativeChange).toHaveBeenCalledTimes(1);
    expect(selector.value).toBe('other');
  });

  it('does not attach duplicate native listeners during concurrent registration', async () => {
    await Promise.all([service.connect(wfs, map), service.connect(wfs, map)]);
    expect(interaction.on).toHaveBeenCalledTimes(1);
  });

  it('uses one combined confirmation before discarding draft and session operations', async () => {
    const discard = wfs.discardEdits;
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    expect(wfs.sitmunDiscardAttributes()).toBe(true);
    await settle();
    expect(discard).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toBe('featureAttribute.confirmSessionMessage');
    answer.next(false);
    await settle();
    expect(discard).not.toHaveBeenCalled();
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    wfs.sitmunDiscardAttributes();
    await settle();
    answer.next(true);
    await settle();
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('restores the native deletion target only after discard consent and retains the native return value', async () => {
    modify.getSelectedFeatures = () => [a];
    modify.setSelectedFeatures = jest.fn();
    const remove = jest.fn();
    modify.onDeleteButtonClick = remove;
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    expect(modify.onDeleteButtonClick()).toBe(modify);
    await settle();
    expect(remove).not.toHaveBeenCalled();
    answer.next(true);
    await settle();
    expect(modify.setSelectedFeatures).toHaveBeenCalledWith([a]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('marks the open form clean only after acknowledged registration', async () => {
    const save = wfs.applyEdits;
    let data = { label: 'A' };
    a.getData = () => data;
    wfs.sitmunAttributeRegistrationVersion = 1;
    let release!: () => void;
    const registered = new Promise<void>((resolve) => { release = resolve; });
    setData.mockImplementation((_feature: unknown, next: { label: string }) => {
      const oldData = data;
      data = { ...next };
      return { type: 'attributesChange', oldData, newData: data };
    });
    edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(registered));
    await open();
    const component = form();
    component.rows[0].group.controls.text.setValue('applied');
    component.submit(new Event('submit'));
    await settle();
    expect(component.busy).toBe(true);
    expect(component.dirty).toBe(true);
    expect(setData).toHaveBeenCalledTimes(1);
    wfs.getLayerEditData = () => ({ modifiedFeaturesLayer: { features: [a] } });
    release();
    await settle();
    expect(form()).toBe(component);
    expect(component.busy).toBe(false);
    expect(component.dirty).toBe(false);
    expect(component.pending).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(edit.trigger).toHaveBeenCalledTimes(1);
  });

  it('preserves a conflicting draft rather than silently overwriting session attributes', async () => {
    let data = { label: 'A' };
    a.getData = () => data;
    wfs.sitmunAttributeRegistrationVersion = 1;
    await open();
    form().rows[0].group.controls.text.setValue('draft');
    data = { label: 'external' };
    form().submit(new Event('submit'));
    await settle();
    expect(form().error).toBe('conflict');
    expect(form().conflictNames).toEqual(['label']);
    expect(form().rows[0].group.controls.text.value).toBe('draft');
    expect(setData).not.toHaveBeenCalled();
  });

  it('maps prefixed integer data into one clean editable draft without changing the original feature', async () => {
    const xml = new DOMParser().parseFromString(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema"
      xmlns:a="urn:a" targetNamespace="urn:a" elementFormDefault="qualified">
      <x:element name="items"><x:complexType><x:sequence><x:element name="count" type="x:int"/>
      </x:sequence></x:complexType></x:element></x:schema>`, 'text/xml');
    layer.proxificationTool.fetchXML = async () => xml;
    layer.getFeatureTypeMetadata = async () => ({ attributes: [{ name: 'count' }], geometries: [] });
    const data = Object.freeze({ 'a:count': '007' });
    a.getData = () => data;
    await open();
    const component = form();
    expect(component.rows).toHaveLength(1);
    expect(component.rows[0].field).toMatchObject({ name: 'a:count', value: '007', editable: true });
    expect(component.dirty).toBe(false);
    component.rows[0].group.controls.text.setValue('8');
    expect(component.dirty).toBe(true);
    expect(data).toEqual({ 'a:count': '007' });
    expect(wfs.sitmunCanSaveAttributes()).toBe(false);
    expect(setData).not.toHaveBeenCalled();
  });

  it.each([true, false])('opts only a schema-declared data id into native updates (declared=%s)', async (declared) => {
    const xml = new DOMParser().parseFromString(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema"
      xmlns:a="urn:a" targetNamespace="urn:a" elementFormDefault="qualified"><x:element name="items"><x:complexType><x:sequence>
      ${declared ? '<x:element name="id" type="x:string"/>' : ''}
      <x:element name="label" type="x:string"/></x:sequence></x:complexType></x:element></x:schema>`, 'text/xml');
    layer.proxificationTool.fetchXML = async () => xml;
    layer.getFeatureTypeMetadata = async () => ({ attributes: [{ name: 'id', isId: true }, { name: 'label' }], geometries: [] });
    let data = { id: 'old-data-id', label: 'A' };
    a.getData = () => data;
    wfs.sitmunAttributeRegistrationVersion = 1;
    setData.mockImplementation((_feature: unknown, next: typeof data) => {
      const oldData = data; data = next;
      return { type: 'attributesChange', oldData, newData: next };
    });
    edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(Promise.resolve()));
    await open();
    expect(layer.sitmunHasDataId).toBe(declared);
    if (declared) {
      form().rows.find((row) => row.field.name === 'id')!.group.controls.text.setValue('new-data-id');
      form().submit(new Event('submit'));
      await settle();
      expect(data.id).toBe('new-data-id');
      expect(a.id).toBe('a');
      expect(form().dirty).toBe(false);
      // Selecting another representation must not suppress the first feature's
      // pending unqualified id when native Save processes the entire layer.
      b.getData = () => ({ 'a:id': 'other-data-id', label: 'B' });
      await click(b, [a]);
      expect(layer.sitmunHasDataId).toBe(true);
    }
    panels.destroyMap(host);
    expect(layer.sitmunHasDataId).toBeUndefined();
  });

  it('applies structured attributes through the native history and installs the layer serializer', async () => {
    const xml = new DOMParser().parseFromString(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema"
      xmlns:a="urn:a" targetNamespace="urn:a"><x:element name="items"><x:complexType><x:sequence>
      <x:element name="details"><x:complexType><x:sequence><x:element name="label" type="x:string"/>
      </x:sequence></x:complexType></x:element></x:sequence></x:complexType></x:element></x:schema>`, 'text/xml');
    layer.proxificationTool.fetchXML = async () => xml;
    layer.getFeatureTypeMetadata = async () => ({ attributes: [{ name: 'details' }], geometries: [] });
    layer.wrap = { sitmunAttributeTransactionVersion: 1 };
    let data = { details: { label: 'A' } };
    a.getData = () => data;
    setData.mockImplementation((_feature: unknown, next: typeof data) => {
      const oldData = data; data = next;
      return { type: 'attributesChange', oldData, newData: next };
    });
    wfs.sitmunAttributeRegistrationVersion = 1;
    edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(Promise.resolve()));
    await open();
    expect(form().dirty).toBe(false);
    expect(typeof layer.sitmunSerializeAttributeTransaction).toBe('function');
    form().rows[0].group.controls.text.setValue('{"label":"B"}');
    form().submit(new Event('submit'));
    await settle();
    expect(data.details).toEqual({ label: 'B' });
    expect(form().dirty).toBe(false);
    expect(setData).toHaveBeenCalledTimes(1);
    layer.wrap.sitmunAttributeTransactionVersion = 0;
    form().rows[0].group.controls.text.setValue('{"label":"C"}');
    form().submit(new Event('submit'));
    await settle();
    expect(form().error).toBe('unverified');
    expect(data.details).toEqual({ label: 'B' });
    expect(setData).toHaveBeenCalledTimes(1);
    service.ngOnDestroy();
    expect(layer.sitmunSerializeAttributeTransaction).toBeUndefined();
  });

  it('preserves declared auxiliary GML bounds but still blocks properties added outside the loaded form', async () => {
    const parse = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml');
    const root = parse(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:a="urn:a"
        xmlns:gml="http://www.opengis.net/gml/3.2" targetNamespace="urn:a" elementFormDefault="qualified">
        <x:import namespace="http://www.opengis.net/gml/3.2" schemaLocation="./bounds.xsd"/>
        <x:element name="items"><x:complexType><x:sequence><x:element name="label" type="x:string"/>
        <x:element ref="gml:boundedBy" minOccurs="0"/></x:sequence></x:complexType></x:element></x:schema>`);
    const boundsSchema = parse(`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema"
        targetNamespace="http://www.opengis.net/gml/3.2"><x:element name="boundedBy"><x:complexType>
        <x:sequence/></x:complexType></x:element></x:schema>`);
    layer.proxificationTool.fetchXML = async (url: string) => url.endsWith('bounds.xsd') ? boundsSchema : root;
    let data: Record<string, unknown> = { 'a:label': 'A', 'gml:boundedBy': [1, 2, 1, 2] };
    a.getData = () => data;
    wfs.sitmunAttributeRegistrationVersion = 1;
    setData.mockImplementation((_feature: unknown, next: Record<string, unknown>) => {
      const oldData = data; data = { ...next };
      return { type: 'attributesChange', oldData, newData: data };
    });
    edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(Promise.resolve()));
    await open();
    form().rows.find((row) => row.field.name === 'a:label')!.group.controls.text.setValue('changed');
    form().submit(new Event('submit'));
    await settle();
    expect(setData).toHaveBeenCalledTimes(1);
    expect(data).toEqual({ 'a:label': 'changed', 'gml:boundedBy': [1, 2, 1, 2] });
    expect(form().dirty).toBe(false);
    data['unknown'] = { nested: 'not verified' };
    form().rows.find((row) => row.field.name === 'a:label')!.group.controls.text.setValue('blocked');
    form().submit(new Event('submit'));
    await settle();
    expect(form().error).toBe('unverified');
    expect(setData).toHaveBeenCalledTimes(1);
    delete data['unknown'];
    data['a:undeclared'] = 'not silently discarded';
    form().submit(new Event('submit'));
    await settle();
    expect(form().error).toBe('unverified');
    expect(setData).toHaveBeenCalledTimes(1);
  });

  describe('verified shops name with inherited GML metadata', () => {
    function prepareShops(fixture = 'shops-gml32-with-name') {
      const xml = new DOMParser().parseFromString(readFileSync(
        join(__dirname, `../utils/fixtures/${fixture}.xsd`), 'utf8'), 'application/xml');
      layer.featureType = ['shops'];
      layer.options = { featureNS: 'menorca' };
      layer.proxificationTool.fetchXML = async () => xml;
      const metadata: NativeAttributeMetadata = {
        name: ['shops'], origin: 'WFS',
        originaData: { name: { '@name': 'name', '@type': 'xsd:string', type: 'string',
          '@minOccurs': 1, '@maxOccurs': 1, '@nillable': false } },
        attributes: [{ name: 'name', originalType: 'string' }, { name: 'gid', isId: true },
          ...['category', 'city', 'municipality', 'employees', 'scope'].map((name) => ({ name }))],
        geometries: [{ name: 'geom' }]
      };
      layer.getFeatureTypeMetadata = jest.fn(async () => metadata);
      const state = { data: { 'menorca:name': 'Comerç rural 60', 'menorca:gid': 60,
        'menorca:category': 'alimentació', 'menorca:city': 'Maó', 'menorca:municipality': 'Maó',
        'menorca:employees': 7, 'menorca:scope': 'local', 'gml:name': 'Inherited GML label',
        'gml:boundedBy': [1, 2, 1, 2] } as Record<string, unknown> };
      a.geometry = Object.freeze([1, 2]);
      a.setCoordinates = jest.fn();
      a.getData = () => state.data;
      wfs.sitmunAttributeRegistrationVersion = 1;
      setData.mockImplementation((_feature: unknown, next: Record<string, unknown>) => {
        const oldData = state.data;
        state.data = { ...next };
        return { type: 'attributesChange', oldData, newData: state.data };
      });
      edit.trigger = jest.fn((_type: string, event: any) => event.sitmunRegister(Promise.resolve()));
      return { state, metadata };
    }

    it('edits only menorca:name, preserves GML/other attributes and geometry, and reuses the mapping after Apply', async () => {
      const { state, metadata } = prepareShops();
      const before = { ...state.data };
      const originalMetadata = JSON.stringify(metadata);
      const geometry = a.geometry;
      const nativeSave = wfs.applyEdits;
      Object.freeze(metadata.attributes![0]);
      Object.freeze(metadata.attributes);
      Object.freeze(metadata);
      await open();
      expect(form().rows.find((row) => row.field.name === 'menorca:name')!.field).toMatchObject({
        value: 'Comerç rural 60', present: true, editable: true, reasons: [] });
      expect(form().rows.some((row) => row.field.name.startsWith('gml:'))).toBe(false);
      expect(form().rows.some((row) => row.field.name === 'geom')).toBe(false);
      expect(form().rows.find((row) => row.field.name === 'menorca:gid')!.field.editable).toBe(true);
      expect(state.data).toEqual(before);
      for (const value of ['Comerç actualitzat', 'Segona edició']) {
        form().rows.find((row) => row.field.name === 'menorca:name')!.group.controls.text.setValue(value);
        form().submit(new Event('submit'));
        await settle();
        expect(form().error).toBe('');
        expect(form().dirty).toBe(false);
        expect(state.data).toEqual({ ...before, 'menorca:name': value });
        expect(form().rows.find((row) => row.field.name === 'menorca:name')!.field).toMatchObject({
          value, editable: true, reasons: [] });
        expect(Object.hasOwn(state.data, 'name')).toBe(false);
      }
      expect(setData).toHaveBeenCalledTimes(2);
      expect(layer.getFeatureTypeMetadata).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(metadata)).toBe(originalMetadata);
      expect(layer.featureType).toEqual(['shops']);
      expect(layer.options).toEqual({ featureNS: 'menorca' });
      expect(a.geometry).toBe(geometry);
      expect(a.setCoordinates).not.toHaveBeenCalled();
      expect(nativeSave).not.toHaveBeenCalled();
    });

    it.each(['missing evidence', 'other feature type', 'ambiguous data'])('keeps %s read-only', async (reason) => {
      const { state, metadata } = prepareShops();
      if (reason === 'missing evidence') delete metadata.originaData;
      if (reason === 'other feature type') metadata.name = ['other'];
      if (reason === 'ambiguous data') state.data['name'] = 'unqualified';
      await open();
      expect(form().rows.find((row) => row.field.name === 'menorca:name')!.field.editable).toBe(false);
      expect(setData).not.toHaveBeenCalled();
    });

    it.each(['synchronizing', 'registration unavailable', 'registration failure', 'conflict', 'unknown property'])
      ('retains the existing %s protection with the resolved name', async (reason) => {
        const { state } = prepareShops();
        await open();
        form().rows.find((row) => row.field.name === 'menorca:name')!.group.controls.text.setValue('draft');
        if (reason === 'synchronizing') wfs.isSyncing = true;
        if (reason === 'registration unavailable') wfs.sitmunAttributeRegistrationVersion = 0;
        if (reason === 'registration failure') {
          edit.trigger = jest.fn((_type: string, event: any) =>
            event.sitmunRegister(Promise.reject(new Error('storage failed'))));
        }
        if (reason === 'conflict') state.data['menorca:name'] = 'concurrent value';
        if (reason === 'unknown property') state.data['unknown'] = 'do not drop';
        form().submit(new Event('submit'));
        await settle();
        expect(form().error).toBe(reason === 'conflict' ? 'conflict'
          : reason === 'registration failure' ? 'registrationFailed' : 'unverified');
        expect(form().dirty).toBe(true);
        expect(setData).toHaveBeenCalledTimes(reason === 'registration failure' ? 1 : 0);
        if (reason !== 'registration failure') {
          expect(state.data['menorca:name']).toBe(reason === 'conflict' ? 'concurrent value' : 'Comerç rural 60');
        }
        if (reason === 'registration failure') expect(wfs.sitmunCanSaveAttributes()).toBe(false);
      });

    it('rejects a changed layer context while native metadata is still loading', async () => {
      const { metadata } = prepareShops();
      let release!: (value: NativeAttributeMetadata) => void;
      layer.getFeatureTypeMetadata = () => new Promise((resolve) => { release = resolve; });
      await open();
      expect(form().state).toBe('loading');
      layer.options.featureNS = 'other';
      release(metadata);
      await settle();
      expect(form().state).toBe('error');
      expect(form().fields).toEqual([]);
      expect(setData).not.toHaveBeenCalled();
    });

    it('ignores late native metadata for A after the selection has changed to B', async () => {
      const { state, metadata } = prepareShops();
      b.getData = () => ({ ...state.data, 'menorca:name': 'Comerç B' });
      let release!: (value: NativeAttributeMetadata) => void;
      layer.getFeatureTypeMetadata = jest.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
        .mockResolvedValue(metadata);
      await service.connect(wfs, map);
      await click(a);
      expect(form().state).toBe('loading');
      await click(b, [a]);
      expect(form().rows.find((row) => row.field.name === 'menorca:name')!.field)
        .toMatchObject({ value: 'Comerç B', editable: true });
      release(metadata);
      await settle();
      expect(form().rows.find((row) => row.field.name === 'menorca:name')!.field)
        .toMatchObject({ value: 'Comerç B', editable: true });
      expect(setData).not.toHaveBeenCalled();
    });
  });
});
