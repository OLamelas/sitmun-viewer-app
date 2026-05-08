import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { AuthenticationService } from '@auth/services/authentication.service';
import { CustomAuthConfig, NavigationPath } from '@config/app.config';

import { AuthenticationGuard } from './authentication-guard';

describe('AuthenticationGuard', () => {
  let guard: AuthenticationGuard;
  let authService: {
    getAuthConfig: jest.Mock;
    isLoggedIn: jest.Mock;
  };
  let navigate: jest.Mock;
  let navigateByUrl: jest.Mock;

  beforeEach(() => {
    authService = {
      getAuthConfig: jest.fn().mockReturnValue(CustomAuthConfig),
      isLoggedIn: jest.fn()
    };
    navigate = jest.fn().mockResolvedValue(true);
    navigateByUrl = jest.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        AuthenticationGuard,
        { provide: AuthenticationService, useValue: authService },
        {
          provide: Router,
          useValue: { navigate, navigateByUrl }
        }
      ]
    });
    guard = TestBed.inject(AuthenticationGuard);
  });

  it('redirects to login with return URL when route is protected and user is not logged in', () => {
    authService.isLoggedIn.mockReturnValue(false);
    const state = { url: '/user/dashboard' } as any;
    const route = {} as any;

    const result = guard.canActivate(route, state);

    expect(result).toBe(false);
    expect(navigate).toHaveBeenCalledWith(
      [CustomAuthConfig.routes.loginPath],
      {
        queryParams: {
          [CustomAuthConfig.routes.loginQueryParam]: '/user/dashboard'
        }
      }
    );
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('allows access when route is public and user is not logged in', () => {
    authService.isLoggedIn.mockReturnValue(false);
    const state = { url: '/auth/login' } as any;

    expect(guard.canActivate({} as any, state)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('navigates to user dashboard when route is public and user is logged in', () => {
    authService.isLoggedIn.mockReturnValue(true);
    const state = { url: '/public/dashboard' } as any;

    expect(guard.canActivate({} as any, state)).toBe(true);
    expect(navigateByUrl).toHaveBeenCalledWith(
      NavigationPath.Section.User.Dashboard
    );
  });

  it('allows access when route is protected and user is logged in', () => {
    authService.isLoggedIn.mockReturnValue(true);
    const state = { url: '/user/map/1/2' } as any;

    expect(guard.canActivate({} as any, state)).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});
