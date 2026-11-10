import { Injectable, inject } from '@angular/core';

import type { AppCfg, AppTasks } from '@api/model/app-cfg';

import { FeatureAttributeEditingService } from '../../services/feature-attribute-editing.service';
import { SitnaApiService } from '../../services/sitna-api.service';
import { WfsEditingPermissionsService } from '../../services/wfs-editing-permissions.service';
import type { SitnaControlConfig } from '../control-handler.interface';
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
  readonly failClosedOnPatchError = true;
  private readonly attributeEditing = inject(FeatureAttributeEditingService);
  private readonly permissions = inject(WfsEditingPermissionsService);

  override buildConfiguration(task: AppTasks, context: AppCfg): SitnaControlConfig {
    return { ...super.buildConfiguration(task, context), sitmunWfsProfile: context };
  }

  onMapClear(map?: object): void { this.permissions.clear(map); }

  constructor(sitnaApi: SitnaApiService) {
    super(sitnaApi);
  }

  override async loadPatches(_context: AppCfg): Promise<void> {
    await this.withTCAsync(async (TC) => {
      const wfsEditPrototype = TC?.control?.WFSEdit?.prototype;
      if (!wfsEditPrototype || typeof wfsEditPrototype.register !== 'function') {
        throw new Error('Mandatory WFSEdit permission interception unavailable');
      }
      if (wfsEditPrototype.__sitmunFeatureAttributeEditing) return;

      const editing = this.attributeEditing;
      const permissions = this.permissions;
      const advice = meld.around(
        wfsEditPrototype,
        'register',
        function (this: any, joinPoint: MeldJoinPoint): unknown {
          const map = joinPoint.args[0];
          try {
            // Install on this instance BEFORE register can schedule any native opening.
            // Never capture loadPatches' first profile in the shared prototype patch.
            permissions.install(this, map, this.options?.sitmunWfsProfile);
          } catch (error) {
            console.error('[WFSEdit] Permission gate installation failed:', error);
            permissions.disable(this, map);
            return Promise.resolve(this);
          }
          return Promise.resolve(joinPoint.proceedApply(joinPoint.args)).then(
            async (result) => {
              permissions.registered(this);
              try {
                await editing.connect(this, map);
              } catch (error) {
                // The mandatory permission gate remains installed if this optional adapter fails.
                console.error('[WFSEdit] Attribute panel integration failed:', error);
              }
              return result;
            }
          ).catch((error) => {
            console.error('[WFSEdit] Native editing registration failed:', error);
            permissions.disable(this, map);
            return this;
          });
        }
      );
      wfsEditPrototype.__sitmunFeatureAttributeEditing = true;
      this.patchManager.add(() => {
        advice.remove();
        delete wfsEditPrototype.__sitmunFeatureAttributeEditing;
      });
    }).catch((error) => {
      this.permissions.reportUnavailable();
      throw error;
    });
  }
}
