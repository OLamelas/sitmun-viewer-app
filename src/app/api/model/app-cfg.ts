import {
  SitnaBaseLayer,
  SitnaControls,
  SitnaViews
} from '@api/model/sitna-cfg';

export interface AppCfg {
  application: AppApplication;
  backgrounds: AppBackground[];
  groups: AppGroup[];
  layers: AppLayer[];
  services: AppService[];
  tasks: AppTasks[];
  trees: AppTree[];
  global?: AppGlobalConfiguration;
}

export interface GeneralCfg {
  locale?: string;
  crs?: string;
  initialExtent?: [number, number, number, number];
  attribution?: string;
  layout: {
    config: string;
    markup: string;
    style: string;
    script: string;
    i18n: string;
  };
  baseLayers: SitnaBaseLayer[];
  controls: SitnaControls;
  views: SitnaViews;
}

export interface AppApplication {
  id: number;
  title: string;
  type: string;
  theme: string;
  srs: string;
  'situation-map'?: string;
  initialExtent: [number, number, number, number];
}

export interface AppBackground {
  id: string;
  title: string;
  thumbnail: string;
}
export interface AppGroup {
  id?: string;
  title?: string;
  layers?: string[];
}

export interface AppLayer {
  id: string;
  title: string;
  layers: string[];
  service: string;
  /** Profile JSON key; omitted when unset (merged onto GetCapabilities in RasterLayerService). */
  minScaleDenominator?: number;
  /** Profile JSON key; omitted when unset (merged onto GetCapabilities in RasterLayerService). */
  maxScaleDenominator?: number;
  /** Layer transparency 0..100 (0 = opaque, 100 = fully transparent); omitted when unset. */
  transparency?: number;
  /** OGC WMS Layer MetadataURL href (profile / cartography). */
  metadataURL?: string;
  /** OGC WMS Layer DataURL href (profile / cartography). */
  datasetURL?: string;
}

export interface AppService {
  id: string;
  url: string;
  type: string;
  parameters: AppParameters;
}

export interface AppParameters {
  matrixSet?: string;
  format?: string;
  SRS?: string;
  VERSION?: string;
}

export interface AppTasks {
  id: string;
  parameters: any;
  'ui-control': string;
}

export interface AppTree {
  id: string;
  title: string;
  image: string | null;
  rootNode: string;
  nodes: any;
}

export interface AppNodeInfo {
  title: string;
  resource: string;
  isRadio: boolean;
  children: string[];
  order: number;
  /** Optional folder-level metadata URL from tree node (client profile). */
  metadataURL?: string;
  /** Optional folder-level dataset URL from tree node (client profile). */
  datasetURL?: string;
}

export interface AppGlobalConfiguration {
  proxy: string;
  language: {
    default: string;
  };
  srs: {
    default: {
      identifier: string;
      x: number;
      y: number;
      proj4: string;
    };
  };
}
