import { Directive, OnDestroy, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';

import {
  CommonService,
  DashboardItem,
  DashboardItemsResponse,
  DashboardTypes
} from '@api/services/common.service';
import { TranslateService } from '@ngx-translate/core';
import { OpenModalService } from '@ui/modal/service/open-modal.service';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Directive()
export abstract class AbstractDashboardComponent implements OnInit, OnDestroy {
  type: DashboardTypes;
  private readonly translateService = inject(TranslateService);
  private readonly destroy$ = new Subject<void>();

  items: DashboardItem[];
  totalElements = 0;
  protected constructor(
    protected router: Router,
    protected commonService: CommonService,
    protected modal: OpenModalService
  ) {
    this.type = DashboardTypes.APPLICATIONS;
    this.items = [];
  }

  ngOnInit() {
    this.loadItems();
    this.translateService.onLangChange
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.loadItems();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadItems(keyword = '') {
    this.commonService
      .fetchDashboardItems(this.type, keyword)
      .subscribe((res: DashboardItemsResponse) => {
        this.items = res.content;
        this.totalElements = res.totalElements;
      });
  }

  onKeywordsSearch(keywords: string) {
    this.loadItems(keywords);
  }
}
