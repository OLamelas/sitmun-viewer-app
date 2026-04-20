import { HttpHandler, HttpRequest } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { of } from 'rxjs';

import { CredentialsInterceptor } from './credentials.interceptor';

describe('CredentialsInterceptor', () => {
  let interceptor: CredentialsInterceptor;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [CredentialsInterceptor]
    });
    interceptor = TestBed.inject(CredentialsInterceptor);
  });

  it('forwards a clone of the request with withCredentials true', (done) => {
    const original = new HttpRequest('GET', '/api/resource');
    const next: HttpHandler = {
      handle: (req) => {
        expect(req).not.toBe(original);
        expect(req.withCredentials).toBe(true);
        expect(req.url).toBe(original.url);
        expect(req.method).toBe(original.method);
        done();
        return of({ type: 4 } as any);
      }
    };

    interceptor.intercept(original, next).subscribe();
  });
});
