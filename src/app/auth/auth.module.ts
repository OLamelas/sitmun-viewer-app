import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { NgModule } from '@angular/core';

import { AuthenticationInterceptor } from '@auth/services/authentication.interceptor';
import { AuthenticationService } from '@auth/services/authentication.service';

@NgModule({
  imports: [],
  providers: [
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthenticationInterceptor,
      multi: true,
      deps: [AuthenticationService]
    }
  ]
})
export class AuthenticationModule {}
