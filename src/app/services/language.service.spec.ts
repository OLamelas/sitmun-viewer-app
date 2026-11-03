import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { I18nService } from '@api/services/i18n.service';
import { AuthenticationService } from '@auth/services/authentication.service';
import { TranslateService } from '@ngx-translate/core';
import { of, firstValueFrom, Subject } from 'rxjs';

import { AppConfigService } from './app-config.service';
import { LanguageService } from './language.service';
import { FeatureAttributeEditingService } from './feature-attribute-editing.service';
import { environment } from '../../environments/environment';

describe('LanguageService', () => {
  let service: LanguageService;
  let httpMock: HttpTestingController;
  let appConfig: jest.Mocked<
    Pick<AppConfigService, 'getDefaultLanguage' | 'getDefaultLanguages' | 'getLanguageIcon'>
  >;

  beforeEach(() => {
    localStorage.removeItem('language');
    appConfig = {
      getDefaultLanguage: jest.fn().mockReturnValue('es'),
      getDefaultLanguages: jest.fn().mockReturnValue([
        { shortname: 'ca', name: 'Català', order: 1 },
        { shortname: 'en', name: 'English', order: 3 },
        { shortname: 'es', name: 'Castellano', order: 2 }
      ]),
      getLanguageIcon: jest.fn().mockReturnValue('')
    };
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: FeatureAttributeEditingService, useValue: {
          reserveMapTransition: jest.fn(() => ({})),
          authorizeMapTransition: jest.fn().mockResolvedValue(true),
          mapTransitionIsCurrent: jest.fn().mockReturnValue(true),
          releaseMapTransition: jest.fn()
        } },
        LanguageService,
        {
          provide: I18nService,
          useValue: {
            getLanguagesTranslated: jest.fn(),
            updateUserLanguage: jest.fn()
          }
        },
        { provide: AppConfigService, useValue: appConfig },
        {
          provide: TranslateService,
          useValue: {
            setDefaultLang: jest.fn(),
            use: jest.fn().mockReturnValue(of({})),
            getTranslation: jest.fn().mockReturnValue(of({})),
            currentLang: 'en'
          }
        },
        {
          provide: AuthenticationService,
          useValue: { isLoggedIn: jest.fn().mockReturnValue(false) }
        }
      ]
    });
    service = TestBed.inject(LanguageService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.removeItem('language');
  });

  async function flushBootstrap(defaultLang = 'en') {
    const bootstrap = service.bootstrapUiLanguage();
    const confReq = httpMock.expectOne(
      `${environment.apiUrl}/api/configuration-parameters`
    );
    confReq.flush({
      _embedded: {
        'configuration-parameters': [{ name: 'language.default', value: defaultLang }]
      }
    });
    await Promise.resolve();
    const langReq = httpMock.expectOne(`${environment.apiUrl}/api/languages`);
    langReq.flush({
      _embedded: {
        languages: [
          { shortname: 'ca', name: 'Català', order: 1, enabled: true },
          { shortname: 'en', name: 'English', order: 3, enabled: true },
          { shortname: 'es', name: 'Castellano', order: 2, enabled: true },
          { shortname: 'fr', name: 'Français', order: 5, enabled: false }
        ]
      }
    });
    await bootstrap;
  }

  it('uses language.default when storage empty', async () => {
    await flushBootstrap('en');
    expect(service.getCurrentLanguage()).toBe('en');
  });

  it('prefers stored language over backend default', async () => {
    localStorage.setItem('language', 'ca');
    await flushBootstrap('en');
    expect(service.getCurrentLanguage()).toBe('ca');
  });

  it('omits disabled languages from the switcher list', async () => {
    await flushBootstrap('en');
    const shortnames = service['availableLanguages'].map((l) => l.shortname);
    expect(shortnames).toEqual(['ca', 'es', 'en']);
    expect(shortnames).not.toContain('fr');
  });

  it('emits languagesToUse$ when the switcher list is applied', async () => {
    const emissions: string[][] = [];
    service.languagesToUse$.subscribe((langs) => {
      emissions.push(langs.map((l) => l.shortname));
    });
    await flushBootstrap('en');
    expect(emissions.at(-1)).toEqual(['ca', 'es', 'en']);
  });

  it('does not mutate translation, storage or backend when map abandonment is cancelled', async () => {
    const editing = TestBed.inject(FeatureAttributeEditingService);
    (editing.authorizeMapTransition as jest.Mock).mockResolvedValue(false);
    const translate = TestBed.inject(TranslateService);
    const updated = jest.fn();
    await new Promise<void>((resolve) => service.setLanguage('ca').subscribe({ next: updated, complete: resolve }));
    expect(translate.use).not.toHaveBeenCalled();
    expect(localStorage.getItem('language')).toBeNull();
    expect(TestBed.inject(I18nService).updateUserLanguage).not.toHaveBeenCalled();
    expect(updated).not.toHaveBeenCalled();
  });

  it('applies a language only after explicit map-abandonment consent', async () => {
    const translate = TestBed.inject(TranslateService);
    const stream = service.setLanguage('ca');
    expect(translate.use).not.toHaveBeenCalled();
    await firstValueFrom(stream);
    expect(translate.use).toHaveBeenCalledWith('ca');
    expect(localStorage.getItem('language')).toBe('ca');
  });

  it('preloads a deferred translation without activating it or syncing the profile', async () => {
    const translation = new Subject<object>();
    const translate = TestBed.inject(TranslateService);
    (translate.getTranslation as jest.Mock).mockReturnValue(translation);
    const editing = TestBed.inject(FeatureAttributeEditingService);
    const subscription = service.setLanguage('ca').subscribe();
    await Promise.resolve();
    expect(translate.getTranslation).toHaveBeenCalledWith('ca');
    expect(translate.use).not.toHaveBeenCalled();
    expect(localStorage.getItem('language')).toBeNull();
    expect(editing.releaseMapTransition).not.toHaveBeenCalled();
    translation.next({});
    expect(translate.use).toHaveBeenCalledWith('ca');
    expect(editing.releaseMapTransition).toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('does not publish a late shared-loader response after unsubscribe', async () => {
    const translation = new Subject<object>();
    const translate = TestBed.inject(TranslateService);
    (translate.getTranslation as jest.Mock).mockReturnValue(translation);
    const subscription = service.setLanguage('ca').subscribe();
    await Promise.resolve();
    subscription.unsubscribe();
    translation.next({});
    expect(translate.use).not.toHaveBeenCalled();
    expect(TestBed.inject(FeatureAttributeEditingService).releaseMapTransition).toHaveBeenCalled();
    expect(TestBed.inject(I18nService).updateUserLanguage).not.toHaveBeenCalled();
  });

  it('releases the reservation on loader failure without changing language or storage', async () => {
    const translation = new Subject<object>();
    const translate = TestBed.inject(TranslateService);
    (translate.getTranslation as jest.Mock).mockReturnValue(translation);
    const failed = jest.fn();
    service.setLanguage('ca').subscribe({ error: failed });
    await Promise.resolve();
    translation.error(new Error('translation unavailable'));
    expect(failed).toHaveBeenCalled();
    expect(translate.use).not.toHaveBeenCalled();
    expect(localStorage.getItem('language')).toBeNull();
    expect(TestBed.inject(FeatureAttributeEditingService).releaseMapTransition).toHaveBeenCalled();
  });

  it('ignores an invalidated authorization and rejects a second pending intention', async () => {
    const translation = new Subject<object>();
    const translate = TestBed.inject(TranslateService);
    const editing = TestBed.inject(FeatureAttributeEditingService);
    (translate.getTranslation as jest.Mock).mockReturnValue(translation);
    service.setLanguage('ca').subscribe();
    await Promise.resolve();
    (editing.reserveMapTransition as jest.Mock).mockReturnValue(null);
    service.setLanguage('es').subscribe();
    (editing.mapTransitionIsCurrent as jest.Mock).mockReturnValue(false);
    translation.next({});
    expect(translate.getTranslation).toHaveBeenCalledTimes(1);
    expect(translate.use).not.toHaveBeenCalled();
  });

  it('does not reserve a transition for the active language', async () => {
    await firstValueFrom(service.setLanguage('en'));
    expect(TestBed.inject(FeatureAttributeEditingService).reserveMapTransition).not.toHaveBeenCalled();
    expect(TestBed.inject(TranslateService).use).not.toHaveBeenCalled();
  });
});
