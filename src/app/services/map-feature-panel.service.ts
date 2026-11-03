import {
  ApplicationRef, ComponentRef, EnvironmentInjector, ErrorHandler, Injectable, OnDestroy,
  Type, createComponent, inject
} from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { MapFeaturePanelComponent } from '../ui/components/map-feature-panel/map-feature-panel.component';

export type MapFeaturePanelMap = HTMLElement | { div: HTMLElement | string };
export type MapFeaturePanelCloseReason = 'close' | 'replace';
export interface MapFeaturePanelRef {
  readonly owner: object;
  readonly contextKey: string;
  readonly isCurrent: boolean;
  readonly closed$: Observable<void>;
  requestClose(): Promise<boolean>;
  /** Stale owners cannot write into a replacement's content. */
  update(update: (content: HTMLElement) => void): boolean;
}
export interface MapFeaturePanelOptions {
  owner: object;
  contextKey: string;
  title: string;
  closeLabel: string;
  mount(content: HTMLElement, ref: MapFeaturePanelRef): () => void;
  canClose?(reason: MapFeaturePanelCloseReason): boolean | Promise<boolean>;
  isValid?(): boolean;
}
interface PanelEntry {
  component: ComponentRef<MapFeaturePanelComponent>;
  options: MapFeaturePanelOptions;
  ref: MapFeaturePanelRef;
  closed: Subject<void>;
  cleanup?: () => void;
  previousFocus: HTMLElement | null;
  closing?: Promise<boolean>;
}

/** One shared, guarded content slot per map element; no WFS or MIA knowledge. */
@Injectable({ providedIn: 'root' })
export class MapFeaturePanelService implements OnDestroy {
  private readonly appRef = inject(ApplicationRef);
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly errors = inject(ErrorHandler);
  private readonly entries = new Map<HTMLElement, PanelEntry>();
  private readonly replacing = new Set<HTMLElement>();
  private readonly invalidated = new Subject<HTMLElement | null>();
  readonly invalidated$ = this.invalidated.asObservable();
  private version = 0;
  private readonly revisions = new WeakMap<HTMLElement, number>();
  private zIndex = 10050;
  private removeFrontListener?: () => void;

  async open(map: MapFeaturePanelMap, options: MapFeaturePanelOptions): Promise<MapFeaturePanelRef | null> {
    const host = this.host(map);
    if (!host || this.replacing.has(host) || options.isValid?.() === false) return null;
    const current = this.entries.get(host);
    if (current?.options.owner === options.owner && current.options.contextKey === options.contextKey) {
      this.front(current.component.location.nativeElement);
      return current.ref;
    }
    const version = this.version;
    if (current) {
      this.replacing.add(host);
      try {
        if (current.options.canClose && !await this.allowClose(current, 'replace')) return null;
        if (version !== this.version || this.entries.get(host) !== current || options.isValid?.() === false) return null;
        this.dispose(host, current, false);
      } finally {
        this.replacing.delete(host);
      }
    }
    const element = document.createElement('app-map-feature-panel');
    const component = createComponent(MapFeaturePanelComponent, {
      hostElement: element, environmentInjector: this.environmentInjector
    });
    host.appendChild(element);
    const closed = new Subject<void>();
    const entry: PanelEntry = {
      component, options, closed,
      previousFocus: current?.previousFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
      ref: {
        owner: options.owner, contextKey: options.contextKey,
        get isCurrent() { return service.entries.get(host) === entry; },
        closed$: closed.asObservable(),
        requestClose: () => this.close(host, entry),
        update: update => {
          if (this.entries.get(host) !== entry) return false;
          update(component.instance.content.nativeElement);
          return true;
        }
      }
    };
    const service = this;
    this.entries.set(host, entry);
    this.bumpRevision(host);
    this.installFrontListener();
    try {
      component.instance.title = options.title;
      component.instance.closeLabel = options.closeLabel;
      component.instance.requestClose = () => { void entry.ref.requestClose(); };
      component.instance.bringToFront = () => this.front(element);
      this.appRef.attachView(component.hostView);
      component.changeDetectorRef.detectChanges();
      entry.cleanup = options.mount(component.instance.content.nativeElement, entry.ref);
      if (!entry.ref.isCurrent) {
        entry.cleanup();
        return null;
      }
      component.instance.initializeBounds();
      this.front(element);
      element.focus({ preventScroll: true });
      return entry.ref;
    } catch (error) {
      this.dispose(host, entry, true);
      throw error;
    }
  }

  /** Mount a real Angular view, including its change detection and destruction. */
  mountComponent<T>(content: HTMLElement, type: Type<T>, initialize?: (ref: ComponentRef<T>) => void): () => void {
    const component = createComponent(type, { environmentInjector: this.environmentInjector });
    let attached = false;
    try {
      initialize?.(component);
      this.appRef.attachView(component.hostView);
      attached = true;
      content.appendChild(component.location.nativeElement);
      component.changeDetectorRef.detectChanges();
    } catch (error) {
      if (attached && !this.appRef.destroyed && !component.hostView.destroyed) {
        this.appRef.detachView(component.hostView);
      }
      if (!component.hostView.destroyed) component.destroy();
      throw error;
    }
    return () => {
      if (!this.appRef.destroyed && !component.hostView.destroyed) {
        this.appRef.detachView(component.hostView);
      }
      if (!component.hostView.destroyed) component.destroy();
    };
  }

  /** Forced invalidation only: map destruction/authentication, never a voluntary close. */
  destroyMap(map: MapFeaturePanelMap): void {
    const host = this.host(map);
    if (!host) return;
    this.version++;
    this.bumpRevision(host);
    const entry = this.entries.get(host);
    if (entry) this.dispose(host, entry, false);
    this.invalidated.next(host);
  }

  destroyOwner(map: MapFeaturePanelMap, owner: object): void {
    const host = this.host(map);
    const entry = host && this.entries.get(host);
    if (host && entry?.options.owner === owner) this.dispose(host, entry, false);
  }

  destroyAll(): void {
    this.version++;
    for (const [host, entry] of this.entries) this.dispose(host, entry, false);
    this.invalidated.next(null);
  }

  /** Capture before scheduling work; a new owner invalidates old opening intents. */
  revision(map: MapFeaturePanelMap): number {
    const host = this.host(map);
    return host ? this.revisions.get(host) ?? 0 : 0;
  }

  ngOnDestroy(): void {
    this.destroyAll();
    this.invalidated.complete();
  }

  private host(map: MapFeaturePanelMap): HTMLElement | null {
    if (map instanceof HTMLElement) return map;
    return typeof map.div === 'string' ? document.getElementById(map.div) : map.div;
  }

  private async allowClose(entry: PanelEntry, reason: MapFeaturePanelCloseReason): Promise<boolean> {
    if (entry.closing) return entry.closing;
    const pending = Promise.resolve().then(() => entry.options.canClose ? entry.options.canClose(reason) : true)
      .then(result => result === true, () => false);
    entry.closing = pending;
    try { return await pending; }
    finally { if (entry.closing === pending) entry.closing = undefined; }
  }

  private async close(host: HTMLElement, entry: PanelEntry): Promise<boolean> {
    if (this.entries.get(host) !== entry) return false;
    if (entry.options.canClose && !await this.allowClose(entry, 'close')) return false;
    if (this.entries.get(host) !== entry) return false;
    this.dispose(host, entry, true);
    return true;
  }

  private dispose(host: HTMLElement, entry: PanelEntry, restoreFocus: boolean): void {
    if (this.entries.get(host) !== entry) return;
    this.entries.delete(host); // Invalidate before any owner callback can run.
    this.bumpRevision(host);
    try {
      entry.cleanup?.();
    } catch (error) {
      this.errors.handleError(error);
    } finally {
      // TestBed and application teardown can destroy ApplicationRef before this
      // root-scoped service receives ngOnDestroy. Its views are already gone then.
      if (!this.appRef.destroyed && !entry.component.hostView.destroyed) {
        this.appRef.detachView(entry.component.hostView);
      }
      if (!entry.component.hostView.destroyed) entry.component.destroy();
      entry.component.location.nativeElement.remove();
      entry.closed.next();
      entry.closed.complete();
      if (restoreFocus && entry.previousFocus?.isConnected) entry.previousFocus.focus({ preventScroll: true });
      if (!this.entries.size) {
        this.removeFrontListener?.();
        this.removeFrontListener = undefined;
      }
    }
  }

  private front(element: HTMLElement): void {
    element.style.zIndex = String(++this.zIndex);
  }

  private bumpRevision(host: HTMLElement): void {
    this.revisions.set(host, (this.revisions.get(host) ?? 0) + 1);
  }

  private installFrontListener(): void {
    if (this.removeFrontListener) return;
    const listener = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const popup = target?.closest<HTMLElement>('.sitmun-map-feature-panel, .tc-ctl-popup');
      if (popup && [...this.entries.keys()].some(host => host.contains(popup))) this.front(popup);
    };
    document.addEventListener('pointerdown', listener, true);
    this.removeFrontListener = () => document.removeEventListener('pointerdown', listener, true);
  }
}
