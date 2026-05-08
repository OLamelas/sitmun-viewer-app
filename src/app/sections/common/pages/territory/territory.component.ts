import { Location } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import {
  CommonService,
  DashboardItem,
  DashboardTypes
} from '@api/services/common.service';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  standalone: false,
  selector: 'app-territory',
  templateUrl: './territory.component.html',
  styleUrls: ['./territory.component.scss']
})
export class TerritoryComponent implements OnInit, OnDestroy {
  territoryId!: number;
  territory!: DashboardItem;
  applications!: DashboardItem[];
  private readonly destroy$ = new Subject<void>();

  constructor(
    private location: Location,
    private router: Router,
    private route: ActivatedRoute,
    private commonService: CommonService,
    private translateService: TranslateService
  ) {}

  ngOnInit() {
    this.route.params.subscribe((params) => {
      this.territoryId = Number(params['territoryId']);
      this.loadTerritory();
    });
    this.translateService.onLangChange
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.loadTerritory();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadTerritory() {
    const terrId = this.route.snapshot.paramMap.get('territoryId');
    this.territoryId = Number(terrId);

    this.commonService
      .fetchDashboardItems(DashboardTypes.TERRITORIES)
      .subscribe({
        next: (res: any) => {
          this.territory = res.content.find((terr: any) => {
            return terr.id == this.territoryId;
          });
        }
      });

    this.commonService
      .fetchApplicationsByTerritory(this.territoryId)
      .subscribe({
        next: (res: any) => {
          this.applications = res.content;
        }
      });
  }
}
