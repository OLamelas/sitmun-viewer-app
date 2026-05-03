import { TestBed } from '@angular/core/testing';

import { AppCfg } from '@api/model/app-cfg';

import { ConfigLookupService } from './config-lookup.service';
import { LanguageService } from './language.service';
import { LayerInfoService } from './layer-info.service';
import { RasterLayerService } from './raster-layer.service';
import { VirtualWmsCapabilitiesService } from './virtual-wms-capabilities.service';
import { WMSCapabilities, WMSLayer } from '../types/wms-capabilities';

describe('RasterLayerService', () => {
  let service: RasterLayerService;
  let virtualWms: VirtualWmsCapabilitiesService;

  const minimalAppCfg = (): AppCfg => ({
    application: {
      id: 1,
      title: 't',
      type: 't',
      theme: 't',
      srs: 'EPSG:25831',
      initialExtent: [0, 0, 1, 1]
    },
    backgrounds: [],
    groups: [],
    layers: [
      {
        id: 'L1',
        title: 'L1',
        layers: ['ns:roads'],
        service: 'S1',
        minScaleDenominator: 1000,
        maxScaleDenominator: 500000
      }
    ],
    services: [
      {
        id: 'S1',
        url: 'https://upstream.example/geoserver/wms',
        type: 'WMS',
        parameters: {}
      }
    ],
    tasks: [],
    trees: []
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        RasterLayerService,
        VirtualWmsCapabilitiesService,
        ConfigLookupService,
        LayerInfoService,
        {
          provide: LanguageService,
          useValue: { getCurrentLanguage: () => 'en' }
        }
      ]
    });
    service = TestBed.inject(RasterLayerService);
    virtualWms = TestBed.inject(VirtualWmsCapabilitiesService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('processWmtCapabilitiesResult', () => {
    it('returns unchanged for virtual capabilities URL', () => {
      const cfg = minimalAppCfg();
      const leaf: WMSLayer = { Name: 'node/x', Title: 'x' };
      const caps = {
        version: '1.3.0',
        Service: {},
        Capability: { Layer: leaf }
      } as WMSCapabilities;
      const url = virtualWms.generateVirtualUrl('node-3');
      const out = service.processWmtCapabilitiesResult(
        { type: 'WMS' },
        url,
        caps,
        cfg
      ) as WMSCapabilities;
      expect(out).toBe(caps);
      expect(leaf.MinScaleDenominator).toBeUndefined();
    });

    it('merges scales on real WMS capabilities when options.serviceId matches', () => {
      const cfg = minimalAppCfg();
      const leaf: WMSLayer = { Name: 'ns:roads', Title: 'roads' };
      const caps = {
        version: '1.3.0',
        Service: {},
        Capability: { Layer: leaf }
      } as WMSCapabilities;
      const layer = { type: 'WMS', options: { serviceId: 'S1' } };
      service.processWmtCapabilitiesResult(
        layer,
        'https://proxy.example/foo?bar',
        caps,
        cfg
      );
      expect(leaf.MinScaleDenominator).toBe(1000);
      expect(leaf.MaxScaleDenominator).toBe(500000);
    });

    it('falls back to URL match when serviceId is absent', () => {
      const cfg = minimalAppCfg();
      const leaf: WMSLayer = { Name: 'ns:roads', Title: 'roads' };
      const caps = {
        version: '1.3.0',
        Service: {},
        Capability: { Layer: leaf }
      } as WMSCapabilities;
      const layer = { type: 'WMS', url: 'https://upstream.example/geoserver/wms/' };
      service.processWmtCapabilitiesResult(
        layer,
        'https://upstream.example/geoserver/wms?REQUEST=GetCapabilities',
        caps,
        cfg
      );
      expect(leaf.MinScaleDenominator).toBe(1000);
    });

    it('applies WMTS scales only for AppLayers on the matched service', () => {
      const cfg: AppCfg = {
        ...minimalAppCfg(),
        layers: [
          {
            id: 'L1',
            title: 'L1',
            layers: ['tile-layer'],
            service: 'S1',
            minScaleDenominator: 200,
            maxScaleDenominator: 20000
          },
          {
            id: 'L2',
            title: 'L2',
            layers: ['tile-layer'],
            service: 'S2',
            minScaleDenominator: 999,
            maxScaleDenominator: 888888
          }
        ],
        services: [
          ...minimalAppCfg().services,
          {
            id: 'S2',
            url: 'https://other.example/wmts',
            type: 'WMTS',
            parameters: {}
          }
        ]
      };
      const wmtsLayer: Record<string, unknown> = {
        Identifier: 'tile-layer',
        Title: 'Tile'
      };
      const caps = { Contents: { Layer: [wmtsLayer] } };
      service.processWmtCapabilitiesResult(
        { type: 'WMTS', options: { serviceId: 'S1' } },
        'https://upstream.example/geoserver/wmts',
        caps,
        cfg
      );
      expect(wmtsLayer['MinScaleDenominator']).toBe(200);
      expect(wmtsLayer['MaxScaleDenominator']).toBe(20000);
    });
  });

  describe('isRasterWms and isRasterWmts', () => {
    it('isRasterWms true for WMS type layer', () => {
      expect(service.isRasterWms({ type: 'WMS' }, 'http://x', minimalAppCfg())).toBe(
        true
      );
    });

    it('isRasterWmts true for WMTS type layer', () => {
      expect(
        service.isRasterWmts({ type: 'WMTS' }, 'http://x', minimalAppCfg())
      ).toBe(true);
    });

    it('isRasterWmts false for plain WMS type', () => {
      expect(
        service.isRasterWmts({ type: 'WMS' }, 'http://x', minimalAppCfg())
      ).toBe(false);
    });

    it('isRasterWms false for plain WMTS type', () => {
      expect(service.isRasterWms({ type: 'WMTS' }, 'http://x', minimalAppCfg())).toBe(
        false
      );
    });
  });
});
