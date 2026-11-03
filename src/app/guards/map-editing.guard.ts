import { inject } from '@angular/core';
import { CanActivateFn, CanDeactivateFn, Router } from '@angular/router';

import { FeatureAttributeEditingService } from '../services/feature-attribute-editing.service';

export const mapEditingDeactivateGuard: CanDeactivateFn<{
  canLeaveMap(): Promise<boolean>;
}> = (component, currentRoute, _currentState, nextState) => {
  let nextRoute = nextState.root;
  while (nextRoute.firstChild) nextRoute = nextRoute.firstChild;
  // Parameter changes on a reused map are handled by mapEditingReuseGuard.
  // Prompting here too would ask twice during the same navigation.
  if (nextRoute.routeConfig === currentRoute.routeConfig) return true;
  return component.canLeaveMap();
};

/** Angular reuses map components for parameter changes: canDeactivate won't run. */
export const mapEditingReuseGuard: CanActivateFn = (next) => {
  const router = inject(Router);
  const editing = inject(FeatureAttributeEditingService);
  let current = router.routerState.snapshot.root;
  while (current.firstChild) current = current.firstChild;
  const reused = current.routeConfig === next.routeConfig;
  const contextChanged = ['applicationId', 'territoryId', 'lang']
    .some((key) => current.params[key] !== next.params[key]);
  return reused && contextChanged ? editing.confirmNavigationAbandonment() : true;
};
