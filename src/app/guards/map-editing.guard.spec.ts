import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { mapEditingDeactivateGuard, mapEditingReuseGuard } from './map-editing.guard';
import { FeatureAttributeEditingService } from '../services/feature-attribute-editing.service';

@Component({ standalone: true, template: '' })
class EditingMap {
  private readonly editing = inject(FeatureAttributeEditingService);
  canLeaveMap(): Promise<boolean> { return this.editing.confirmNavigationAbandonment(); }
}

@Component({ standalone: true, template: '' })
class Home {}

describe('map editing route guards', () => {
  let confirm: jest.Mock;
  let router: Router;

  beforeEach(async () => {
    confirm = jest.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({ providers: [
      { provide: FeatureAttributeEditingService, useValue: { confirmNavigationAbandonment: confirm } },
      provideRouter([
        { path: 'map/:applicationId/:territoryId', component: EditingMap,
          canActivate: [mapEditingReuseGuard], canDeactivate: [mapEditingDeactivateGuard],
          runGuardsAndResolvers: 'paramsChange' },
        { path: 'home', component: Home }
      ])
    ] });
    await RouterTestingHarness.create('/map/1/2');
    router = TestBed.inject(Router);
    confirm.mockClear();
  });

  it('guards changed parameters of a reused map, once, before route params can change', async () => {
    confirm.mockResolvedValue(false);
    expect(await router.navigateByUrl('/map/3/4')).toBe(false);
    expect(router.url).toBe('/map/1/2');
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    expect(await router.navigateByUrl('/map/3/4')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('guards map deactivation and leaves the map intact on cancellation', async () => {
    confirm.mockResolvedValue(false);
    expect(await router.navigateByUrl('/home')).toBe(false);
    expect(router.url).toBe('/map/1/2');
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    expect(await router.navigateByUrl('/home')).toBe(true);
  });

  it('does not prompt for query-only updates which do not reconstruct the map', async () => {
    await router.navigateByUrl('/map/1/2?panel=open');
    expect(confirm).not.toHaveBeenCalled();
  });
});
