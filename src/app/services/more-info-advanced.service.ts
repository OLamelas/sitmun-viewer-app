import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';

import { AppCfg } from '@api/model/app-cfg';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { environment } from '../../environments/environment';

/**
 * Represents a child task inside a More Info Advanced (MIA) task.
 */
export interface MiaChildTask {
  id: string;
  name: string;
  order: number;
  childType: 'query' | 'template';
  scope: string | null;
  url: string | null;
  parameters: Record<string, any> | null;
  childTaskParameters?: Record<string, Record<string, any>> | null;
}

/**
 * Represents a registered MIA task with its configuration.
 */
export interface MiaTask {
  id: string;
  name: string;
  cartographyId: string;
  visualizationMode: 'tabs' | 'scroll';
  includedTasks: MiaChildTask[];
}

export interface MiaRenderedTask {
  taskId: number;
  title: string;
  html: string;
  error?: string | null;
}

interface MiaRenderResponse {
  tasks?: MiaRenderedTask[];
}

/**
 * Service for handling "More Info Advanced" (MIA) functionality.
 * MIA tasks are composite tasks that group multiple child queries/templates
 * and display them in a floating modal with tabs or scroll mode.
 */
@Injectable({
  providedIn: 'root'
})
export class MoreInfoAdvancedService {
  private static readonly BASIC_TASK_TYPE_ID = 1;
  private static readonly MIA_TASK_TYPE_ID = 16;

  private readonly miaTasksByCartography = new Map<string, MiaTask[]>();
  private hasMiaControlTask = false;

  constructor(private readonly http: HttpClient) {}

  /**
   * Initializes MIA tasks from the application configuration.
   * Extracts tasks with ui-control 'sitna.moreInfoAdvanced' and indexes by cartographyId.
   */
  initialize(config: AppCfg): void {
    this.miaTasksByCartography.clear();
    this.hasMiaControlTask = false;
    if (!config?.tasks) {
      return;
    }

    config.tasks.forEach((task: any) => {
      if (this.isMiaControlTask(task)) {
        this.hasMiaControlTask = true;
      }

      if (this.isRenderableMiaTask(task)) {
        const miaTask = this.parseMiaTask(task);
        if (miaTask) {
          const key = miaTask.cartographyId;
          const existing = this.miaTasksByCartography.get(key) || [];
          existing.push(miaTask);
          this.miaTasksByCartography.set(key, existing);
        }
      }
    });
  }

  /**
   * Returns all MIA tasks for a given cartography ID.
   */
  getTasksForCartography(cartographyId: string): MiaTask[] {
    return this.miaTasksByCartography.get(String(cartographyId)) || [];
  }

  /**
   * Returns true if any MIA tasks are registered.
   */
  hasMiaTasks(): boolean {
    return this.hasMiaControlTask && this.miaTasksByCartography.size > 0;
  }

  renderMiaTasks(miaTasks: MiaTask[], featureData: any): Observable<MiaRenderedTask[]> {
    const body = {
      miaTaskIds: miaTasks.map((task) => this.parseTaskId(task.id)).filter(Number.isFinite),
      parameters: featureData || {}
    };

    return this.http.post<MiaRenderResponse>(
      `${environment.apiUrl}/api/tasks/template/more-info-advanced/render`,
      body
    ).pipe(
      map((response) => response.tasks || []),
      catchError((error) => of([{
        taskId: 0,
        title: '',
        html: '',
        error: error.message || 'MIA rendering failed'
      }]))
    );
  }

  private parseTaskId(id: string): number {
    const match = /(?:^|\/)\d+$/.exec(id);
    return match ? Number(match[0].replace('/', '')) : Number(id);
  }

  private parseMiaTask(task: any): MiaTask | null {
    const params = task.parameters || {};
    const cartographyId = task.cartographyId || params.cartographyId;
    if (!cartographyId) {
      return null;
    }

    const visualizationMode =
      params.visualizationMode === 'scroll' ? 'scroll' : 'tabs';

    const rawIncluded: any[] = Array.isArray(params.includedTasks)
      ? params.includedTasks
      : [];
    const includedTasks: MiaChildTask[] = rawIncluded
      .map((child: any) => ({
        id: child.id || '',
        name: child.name || '',
        order: typeof child.order === 'number' ? child.order : 999,
        childType: child.childType === 'template' ? 'template' as const : 'query' as const,
        scope: child.scope || null,
        url: child.url || null,
        parameters: child.parameters || null,
        childTaskParameters: child.childTaskParameters || null,
      }))
      .sort((a, b) => a.order - b.order);

    return {
      id: task.id || '',
      name: task.name || params.title || '',
      cartographyId: String(cartographyId),
      visualizationMode,
      includedTasks,
    };
  }

  private isMiaControlTask(task: any): boolean {
    return task?.['ui-control'] === 'sitna.moreInfoAdvanced'
      && task?.typeId === MoreInfoAdvancedService.BASIC_TASK_TYPE_ID;
  }

  private isRenderableMiaTask(task: any): boolean {
    const params = task?.parameters || {};
    return task?.typeId === MoreInfoAdvancedService.MIA_TASK_TYPE_ID
      && (params.advancedTaskKind == null || params.advancedTaskKind === 'parent')
      && !!(task.cartographyId || params.cartographyId);
  }

}
