import { HttpClient } from '@angular/common/http';
import { Inject, Injectable } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import {
  URL_API_USER_ACCOUNT,
  URL_AUTH_LOGIN,
  URL_AUTH_LOGOUT,
  URL_AUTH_METHODS,
  URL_AUTH_PROXY,
  URL_OIDC_AUTH
} from '@api/api-config';
import { UserDto } from '@api/model/user';
import {
  AUTH_CONFIG_DI,
  AuthConfig,
  AuthenticationRequest
} from '@auth/authentication.options';
import { NavigationPath, QueryParam } from '@config/app.config';
import { Observable, Subscription, catchError, map, of, switchMap, tap, timer } from 'rxjs';

import { IndexedDbService } from './indexed-db.service';
import { environment } from '../../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AuthenticationService<T> {
  // sessionStorage keys
  private readonly USERNAME_KEY: string;

  private proxyRefreshSubscription: Subscription | null = null;
  private indexedDbInitialized = false;

  constructor(
    private readonly http: HttpClient,
    private readonly router: Router,
    private readonly indexedDb: IndexedDbService,
    @Inject(AUTH_CONFIG_DI) private readonly config: AuthConfig<T>
  ) {
    this.USERNAME_KEY = this.config.localStoragePrefix + '_username';
  }

  async initializeIndexedDb(): Promise<void> {
    if (this.indexedDbInitialized) {
      return;
    }

    try {
      await this.indexedDb.init();
      this.indexedDbInitialized = true;
    } catch (err) {
      console.warn('Failed to init IndexedDB:', err);
    }
  }

  login(authenticationRequest: AuthenticationRequest) {
    return this.http
      .post<void>(environment.apiUrl + URL_AUTH_LOGIN, authenticationRequest)
      .pipe(
        switchMap(() =>
          this.http.get<UserDto>(environment.apiUrl + URL_API_USER_ACCOUNT)
        ),
        tap((user: UserDto) => {
          sessionStorage.setItem(this.USERNAME_KEY, user.username);
          this.startProxyTokenRefresh();
        })
      );
  }

  loginRedirect(route: ActivatedRoute) {
    // Check for redirect query parameter
    const redirectUrl =
      route.snapshot.queryParams[QueryParam.Login.RedirectAfterLogin];

    if (redirectUrl) {
      // Redirect to the originally requested URL
      void this.router.navigateByUrl(redirectUrl);
    } else {
      void this.router.navigateByUrl(NavigationPath.Section.User.Dashboard);
    }
  }

  logout(): void {
    this.http
      .post<void>(environment.apiUrl + URL_AUTH_LOGOUT, null)
      .subscribe(() => {
        this.clearSessionAndRedirectToLogin();
      });
  }

  getAuthMethods() {
    return this.http.get(environment.apiUrl + URL_AUTH_METHODS);
  }

  initOidcAuth(providerId: string) {
    globalThis.location.href = `${environment.apiUrl}${URL_OIDC_AUTH}/${providerId}?client_type=viewer`;
  }

  authorizeOidcUser(): Observable<void> {
    return this.http
      .get<UserDto>(environment.apiUrl + URL_API_USER_ACCOUNT)
      .pipe(
        tap((user: UserDto) => {
          sessionStorage.setItem(this.USERNAME_KEY, user.username);
          this.startProxyTokenRefresh();
        }),
        map(() => undefined)
      );
  }

  // Helpers ------------------------------------------------------------------

  getAuthConfig(): AuthConfig<T> {
    return this.config;
  }

  isLoggedIn(): boolean {
    return !!sessionStorage.getItem(this.USERNAME_KEY);
  }

  getLoggedUsername(): string {
    return sessionStorage.getItem(this.USERNAME_KEY) ?? '';
  }

  // Proxy token refresh -------------------------------------------------------

  private startProxyTokenRefresh(): void {
    if (this.proxyRefreshSubscription) {
      this.proxyRefreshSubscription.unsubscribe();
    }

    this.proxyRefreshSubscription = timer(
      0,
      environment.proxyTokenRefreshIntervalMs
    )
      .pipe(switchMap(() => this.refreshProxyToken()))
      .subscribe();
  }

  private refreshProxyToken() {
    return this.http
      .post<{ proxy_token?: string }>(environment.apiUrl + URL_AUTH_PROXY, null)
      .pipe(
        switchMap(async (response) => {
          if (response.proxy_token) {
            await this.indexedDb.set('proxy_token', response.proxy_token);
          }
          return response;
        }),
        catchError((err) => {
          console.warn('Error refreshing proxy token:', err);
          return of(null);
        })
      );
  }

  private stopProxyTokenRefresh(): void {
    if (this.proxyRefreshSubscription) {
      this.proxyRefreshSubscription.unsubscribe();
      this.proxyRefreshSubscription = null;
    }
  }

  // Session utils ------------------------------------------------------------

  clearSessionAndRedirectToLogin(): void {
    this.clearSession();
    void this.router.navigateByUrl(this.config.routes.loginPath);
  }

  private clearSession(): void {
    sessionStorage.removeItem(this.USERNAME_KEY);
    this.stopProxyTokenRefresh();
    this.indexedDb
      .remove('proxy_token')
      .catch((err) => console.warn('Error clearing proxy token:', err));
  }
}
