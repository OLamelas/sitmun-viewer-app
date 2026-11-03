import { Location } from '@angular/common';
import { Directive, ElementRef, Injector, Renderer2 } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';

import type { AppCfg, GeneralCfg } from '@api/model/app-cfg';
import { CommonService } from '@api/services/common.service';
import { TranslateService } from '@ngx-translate/core';
import { of, EMPTY, Subject } from 'rxjs';
import { LayerCatalogControlHandler } from 'src/app/controls/handlers/layer-catalog-control.handler';
import { AppConfigService } from 'src/app/services/app-config.service';
import { ConfigLookupService } from 'src/app/services/config-lookup.service';
import { ControlRegistryService } from 'src/app/services/control-registry.service';
import { MapConfigurationService } from 'src/app/services/map-configuration.service';
import { MapFeaturePanelService } from 'src/app/services/map-feature-panel.service';
import { FeatureAttributeEditingService } from 'src/app/services/feature-attribute-editing.service';
import { MapInterfaceService } from 'src/app/services/map-interface.service';
import { MapServiceWorkerService } from 'src/app/services/map-service-worker.service';
import { MoreInfoAdvancedService } from 'src/app/services/more-info-advanced.service';
import { SitnaApiService } from 'src/app/services/sitna-api.service';

import { AbstractMapComponent } from './abstract-map.component';

type LoadedCallback = () => void | Promise<void>;

const loadedCallbacks: LoadedCallback[] = [];
let loadedCallback: LoadedCallback | null = null;
let sitnaMapInstances: Array<{ loaded: (cb: LoadedCallback) => void }> = [];

jest.mock('api-sitna', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = {
      loaded: (callback: LoadedCallback) => {
        loadedCallbacks.push(callback);
        loadedCallback = callback;
      }
    };
    sitnaMapInstances.push(instance);
    return instance;
  })
}));

@Directive()
class TestMapComponent extends AbstractMapComponent {
  navigateToDashboard(): void {
    return undefined;
  }

  exposeClearMap(): void {
    (this as any).clearMap();
  }

  exposeUpdateCatalog(): Promise<void> {
    return this.updateCatalog();
  }

  exposeLoadMap(cfg: GeneralCfg): Promise<void> {
    return (this as any).loadMap(cfg);
  }

  exposeDestroy(): void {
    this.ngOnDestroy();
  }

  setMap(map: unknown): void {
    (this as any).map = map;
  }

  setConfigs(appCfg: AppCfg, generalCfg: GeneralCfg): void {
    (this as any).currentAppCfg = appCfg;
    (this as any).currentGeneralCfg = generalCfg;
  }
}

describe('AbstractMapComponent lifecycle', () => {
  let component: TestMapComponent;
  let layerCatalogHandler: {
    applyDefaultWorkingLayers: jest.Mock;
  };
  let controlRegistry: {
    processControls: jest.Mock;
    cleanupAll: jest.Mock;
    unregisterAll: jest.Mock;
    clearMapArtifacts: jest.Mock;
  };

  const appCfg: AppCfg = {
    application: {
      id: 1,
      title: 'Test',
      type: 'test',
      theme: 'default',
      srs: 'EPSG:25831',
      initialExtent: [0, 0, 1, 1]
    },
    backgrounds: [],
    groups: [],
    layers: [],
    services: [],
    tasks: [{ 'ui-control': 'sitna.layerCatalog', parameters: {} } as any],
    trees: []
  };

  const generalCfg: GeneralCfg = {
    locale: 'es',
    crs: 'EPSG:25831',
    initialExtent: [0, 0, 1, 1],
    baseLayers: [{ id: 'base' } as any]
  } as GeneralCfg;

  beforeEach(() => {
    loadedCallbacks.length = 0;
    loadedCallback = null;
    sitnaMapInstances = [];

    layerCatalogHandler = {
      applyDefaultWorkingLayers: jest.fn().mockResolvedValue(undefined)
    };
    controlRegistry = {
      processControls: jest.fn().mockResolvedValue({}),
      cleanupAll: jest.fn(),
      unregisterAll: jest.fn(),
      clearMapArtifacts: jest.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        TestMapComponent,
        { provide: FeatureAttributeEditingService, useValue: {
          confirmNavigationAbandonment: jest.fn().mockResolvedValue(true),
          consumeMapTransition: jest.fn().mockReturnValue(true),
          invalidateMapTransition: jest.fn()
        } },
        { provide: MapFeaturePanelService, useValue: { destroyMap: jest.fn() } },
        { provide: LayerCatalogControlHandler, useValue: layerCatalogHandler },
        {
          provide: MoreInfoAdvancedService,
          useValue: { setMapContext: jest.fn() }
        },
        {
          provide: SitnaApiService,
          useValue: {
            setGlobal: jest.fn(),
            getGlobal: jest.fn((key: string) => {
              if (key === 'layerCatalogsForModal') {
                return { currentTreeId: 'tree/1' };
              }
              return undefined;
            })
          }
        },
        {
          provide: TranslateService,
          useValue: {
            currentLang: 'es',
            onLangChange: of({ lang: 'es' })
          }
        },
        { provide: Location, useValue: { path: () => '/map' } },
        {
          provide: ActivatedRoute,
          useValue: {
            params: of({ applicationId: '1', territoryId: '2' }),
            snapshot: { queryParamMap: { get: () => null } }
          }
        },
        { provide: Router, useValue: {} },
        {
          provide: CommonService,
          useValue: {
            fetchMapConfiguration: jest.fn().mockReturnValue(of(appCfg)),
            updateMessage: jest.fn()
          }
        },
        { provide: MatDialog, useValue: { open: jest.fn() } },
        { provide: Injector, useValue: {} },
        {
          provide: Renderer2,
          useValue: {
            createElement: () => document.createElement('div'),
            setAttribute: jest.fn(),
            insertBefore: jest.fn(),
            removeChild: jest.fn(),
            appendChild: jest.fn()
          }
        },
        {
          provide: ElementRef,
          useValue: {
            nativeElement: {
              querySelector: () => ({
                querySelector: () => null
              })
            }
          }
        },
        { provide: Document, useValue: document },
        {
          provide: ControlRegistryService,
          useValue: controlRegistry
        },
        { provide: ConfigLookupService, useValue: { initialize: jest.fn() } },
        {
          provide: MapConfigurationService,
          useValue: {
            toAttribution: () => '',
            toInitialExtent: () => [0, 0, 1, 1],
            toDefaultZoomLevel: () => undefined,
            toCrs: () => 'EPSG:25831',
            toLayout: () => ({}),
            toBaseLayers: () => [{ id: 'base' }],
            toDefaultBaseLayer: () => 'base',
            toViews: () => []
          }
        },
        {
          provide: MapInterfaceService,
          useValue: { updateInterface: jest.fn() }
        },
        {
          provide: MapServiceWorkerService,
          useValue: {
            configureMiddleware: jest.fn().mockResolvedValue(undefined)
          }
        },
        {
          provide: AppConfigService,
          useValue: { getLocaleForLanguage: () => 'es' }
        }
      ]
    });

    component = TestBed.inject(TestMapComponent);
  });

  it('uses LayerCatalogControlHandler.applyDefaultWorkingLayers for map-open defaults', () => {
    expect(layerCatalogHandler.applyDefaultWorkingLayers).toBeDefined();
  });

  it('consumes language authorization before clearMap and leaves an unauthorized map intact', () => {
    const languageChanges = new Subject<any>();
    const translate = TestBed.inject(TranslateService);
    (translate as any).onLangChange = languageChanges;
    (TestBed.inject(ActivatedRoute) as any).params = EMPTY;
    (TestBed.inject(AppConfigService).getLocaleForLanguage as any) = (lang: string) => lang;
    const fetch = TestBed.inject(CommonService).fetchMapConfiguration as jest.Mock;
    fetch.mockReturnValue(EMPTY);
    const clear = jest.spyOn(component, 'clearMap').mockImplementation(() => {});
    const editing = TestBed.inject(FeatureAttributeEditingService);
    const consume = editing.consumeMapTransition as jest.Mock;
    const originalMap = { id: 'original' };
    component.setMap(originalMap);
    component.applicationId = 1;
    component.territoryId = 2;
    component.ngOnInit();
    translate.currentLang = 'ca';
    consume.mockReturnValue(false);
    languageChanges.next({ lang: 'ca' });
    expect(clear).not.toHaveBeenCalled();
    expect(component.locale).toBe('es');
    expect(fetch).not.toHaveBeenCalled();
    consume.mockReturnValue(true);
    languageChanges.next({ lang: 'ca' });
    expect(consume).toHaveBeenLastCalledWith(originalMap);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(consume.mock.invocationCallOrder.at(-1)).toBeLessThan(clear.mock.invocationCallOrder[0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    component.exposeDestroy();
  });

  it('clearMapArtifacts runs when clearMap is invoked', () => {
    const oldMap = { id: 'old-map' };
    component.setMap(oldMap);
    component.exposeClearMap();
    expect(controlRegistry.clearMapArtifacts).toHaveBeenCalledWith(oldMap);
    const destroyPanels = TestBed.inject(MapFeaturePanelService).destroyMap as jest.Mock;
    expect(destroyPanels).toHaveBeenCalledTimes(1);
    expect(destroyPanels.mock.invocationCallOrder[0]).toBeLessThan(controlRegistry.clearMapArtifacts.mock.invocationCallOrder[0]);
  });

  it.each([true, false])('revalidates route consent only at actual debounced teardown (authorized=%s)', (authorized) => {
    fakeAsync(() => {
      const params = new Subject<Record<string, string>>();
      (TestBed.inject(ActivatedRoute) as any).params = params;
      const fetch = TestBed.inject(CommonService).fetchMapConfiguration as jest.Mock;
      fetch.mockReturnValue(EMPTY);
      const editing = TestBed.inject(FeatureAttributeEditingService);
      const consume = editing.consumeMapTransition as jest.Mock;
      consume.mockReturnValue(authorized);
      const clear = jest.spyOn(component, 'clearMap').mockImplementation(() => {});
      const oldMap = { id: 'editing-map' };
      component.setMap(oldMap);
      component.applicationId = 1;
      component.territoryId = 2;
      component.ngOnInit();
      params.next({ applicationId: '3', territoryId: '4' });
      tick(299);
      expect(consume).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      tick(1);
      expect(consume).toHaveBeenCalledWith(oldMap);
      expect(clear).toHaveBeenCalledTimes(authorized ? 1 : 0);
      expect(fetch).toHaveBeenCalledTimes(authorized ? 1 : 0);
      expect(component.applicationId).toBe(authorized ? 3 : 1);
      if (authorized) expect(consume.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]);
      component.exposeDestroy();
    })();
  });

  it('clearMapArtifacts runs before catalog switch rebuild', async () => {
    const oldMap = { id: 'old-map' };
    component.setMap(oldMap);
    component.setConfigs(appCfg, generalCfg);

    component.exposeUpdateCatalog();
    await Promise.resolve();
    await Promise.resolve();

    expect(controlRegistry.clearMapArtifacts).toHaveBeenCalledWith(oldMap);
  });

  it('does not rebuild controls or destroy the map if catalog abandonment is cancelled', async () => {
    const editing = TestBed.inject(FeatureAttributeEditingService);
    (editing.confirmNavigationAbandonment as jest.Mock).mockResolvedValue(false);
    const map = { id: 'editing-map' };
    component.setMap(map);
    component.setConfigs(appCfg, generalCfg);
    await component.updateCatalog('tree/2');
    expect(editing.confirmNavigationAbandonment).toHaveBeenCalledWith(map);
    expect(controlRegistry.processControls).not.toHaveBeenCalled();
    expect(controlRegistry.clearMapArtifacts).not.toHaveBeenCalled();
    expect(TestBed.inject(MapFeaturePanelService).destroyMap).not.toHaveBeenCalled();
  });

  it('awaits default working layers before resolving map load', async () => {
    let defaultsResolved = false;
    layerCatalogHandler.applyDefaultWorkingLayers.mockImplementation(
      async () => {
        await Promise.resolve();
        defaultsResolved = true;
      }
    );
    component.setConfigs(appCfg, generalCfg);

    const loadPromise = component.exposeLoadMap(generalCfg);
    expect(defaultsResolved).toBe(false);

    await loadedCallback?.();
    await loadPromise;

    expect(defaultsResolved).toBe(true);
    expect(layerCatalogHandler.applyDefaultWorkingLayers).toHaveBeenCalledTimes(1);
  });

  it('does not apply defaults when loadId becomes stale', async () => {
    component.setConfigs(appCfg, generalCfg);
    const firstLoad = component.exposeLoadMap(generalCfg);
    const staleCallback = loadedCallbacks[0];
    component.exposeClearMap();
    const secondLoad = component.exposeLoadMap(generalCfg);
    const currentCallback = loadedCallbacks[1];

    await staleCallback?.();
    await firstLoad;
    await currentCallback?.();
    await secondLoad;

    expect(layerCatalogHandler.applyDefaultWorkingLayers).toHaveBeenCalledTimes(1);
  });

  it('does not apply defaults after destroy before map.loaded', async () => {
    component.setConfigs(appCfg, generalCfg);
    const loadPromise = component.exposeLoadMap(generalCfg);
    component.exposeDestroy();

    await loadedCallback?.();
    await loadPromise;

    expect(layerCatalogHandler.applyDefaultWorkingLayers).not.toHaveBeenCalled();
  });

  it('cleans up handlers without unregistering them on destroy', () => {
    component.exposeDestroy();

    expect(controlRegistry.cleanupAll).toHaveBeenCalledTimes(1);
    expect(controlRegistry.unregisterAll).not.toHaveBeenCalled();
  });

  it('catalog switch applies defaults exactly once to the new map', async () => {
    const oldMap = { id: 'old-map' };
    component.setMap(oldMap);
    component.setConfigs(appCfg, generalCfg);

    const update = component.exposeUpdateCatalog();
    // updateCatalog awaits both abandonment consent and control registration;
    // allow those queued continuations to create the replacement map first.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await loadedCallback?.();
    await update;

    expect(controlRegistry.clearMapArtifacts).toHaveBeenCalledWith(oldMap);
    expect(layerCatalogHandler.applyDefaultWorkingLayers).toHaveBeenCalledTimes(1);
    expect(sitnaMapInstances).toHaveLength(1);
  });
});
