import { Injectable, inject } from '@angular/core';

import type { AppCfg } from '@api/model/app-cfg';

import { FeatureAttributeEditingService } from '../../services/feature-attribute-editing.service';
import { SitnaApiService } from '../../services/sitna-api.service';
import type { Meld, MeldJoinPoint } from '../../types/meld.types';
import { ControlHandlerBase } from '../control-handler-base';

declare function require(module: string): unknown;

const meld = require('meld') as Meld;

/**
 * Handler for the native SITNA WFSEdit control.
 * Allows users to edit WFS layer features (create, modify, delete).
 *
 * Control Type: sitna.WFSEdit
 * Patches: None (native SITNA control)
 * Configuration: div + optional parameters
 *
 * Supported options (from SITNA 4.8):
 * - div?: HTMLElement | string - Element to create the control in
 * - downloadElevation?: ElevationOptions | boolean - Enable elevation download (default: false)
 * - highlightChanges?: boolean - Highlight modified features (default: true)
 * - showOriginalFeatures?: boolean - Show original features alongside modified (default: false)
 * - snapping?: boolean - Enable vertex snapping during editing (default: true)
 * - styles?: StyleOptions - Style options for edited features by geometry type
 */
@Injectable({
  providedIn: 'root'
})
export class WFSEditControlHandler extends ControlHandlerBase {
  readonly controlIdentifier = 'sitna.WFSEdit';
  readonly sitnaConfigKey = 'WFSEdit';
  readonly requiredPatches = undefined;
  private readonly attributeEditing = inject(FeatureAttributeEditingService);

  constructor(sitnaApi: SitnaApiService) {
    super(sitnaApi);
  }

  override async loadPatches(_context: AppCfg): Promise<void> {
    await this.withTCAsync(async (TC) => {
      const wfsEditPrototype = TC?.control?.WFSEdit?.prototype;
      if (
        !wfsEditPrototype ||
        typeof wfsEditPrototype.register !== 'function' ||
        wfsEditPrototype.__sitmunFeatureAttributeEditing
      ) {
        return;
      }

      const editing = this.attributeEditing;
      const advice = meld.around(
        wfsEditPrototype,
        'register',
        function (this: any, joinPoint: MeldJoinPoint): unknown {
          const map = joinPoint.args[0];
          return Promise.resolve(joinPoint.proceedApply(joinPoint.args)).then(
            async (result) => {
              try {
                await editing.connect(this, map);
              } catch (error) {
                // Keep native WFSEdit available if the optional phase-2 adapter fails.
                console.error('[WFSEdit] Attribute panel integration failed:', error);
              }
              return result;
            }
          );
        }
      );
      wfsEditPrototype.__sitmunFeatureAttributeEditing = true;
      this.patchManager.add(() => {
        advice.remove();
        delete wfsEditPrototype.__sitmunFeatureAttributeEditing;
      });
    });
  }
}
