import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthenticationService } from '@auth/services/authentication.service';
import { TranslateService } from '@ngx-translate/core';
import { Observable, catchError, from, map, of, switchMap } from 'rxjs';

import { NotificationService } from '../../notifications/services/NotificationService';
import { FeatureAttributeEditingService } from '../../services/feature-attribute-editing.service';

/**
 * Clears the backend HttpOnly `viewer_access_token` and local viewer state before any
 * `/public/**` route activates. This prevents stale cookies from a previous
 * authenticated session from being sent to public config/profile requests.
 *
 * The logout request to {@code POST /api/authenticate/logout} is sent without the
 * {@code X-SITMUN-Client} header so only the viewer cookie is cleared; admin sessions
 * on other tabs are not affected.
 *
 * If the logout request fails, local session cleanup still runs inside
 * {@link AuthenticationService.clearAuthentication}; navigation proceeds with a warning.
 */
export const publicAuthClearGuard: CanActivateFn = (next): Observable<boolean> => {
  const authService = inject(AuthenticationService);
  const notificationService = inject(NotificationService);
  const translate = inject(TranslateService);
  const editing = inject(FeatureAttributeEditingService);
  const router = inject(Router);
  let current = router.routerState.snapshot.root;
  while (current.firstChild) current = current.firstChild;
  // Guard arrays run concurrently. Await consent here, before authentication
  // cleanup can destroy a reused public map and its Angular draft.
  const reusedMap = current.routeConfig === next.routeConfig && next.routeConfig?.path?.startsWith('map/');

  return (reusedMap ? from(editing.confirmNavigationAbandonment()) : of(true)).pipe(
    switchMap((allowed) => {
      if (!allowed) return of(false);
      return authService.clearAuthentication().pipe(
        map(() => true),
        catchError((error: unknown) => {
          console.error('[publicAuthClearGuard] Could not clear authentication before public access:', error);
          translate.get('auth.publicAccessFailed').subscribe((message) => {
            notificationService.warning(message);
          });
          return of(true);
        })
      );
    })
  );
};
