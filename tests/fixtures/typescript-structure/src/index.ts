import { TaskService } from './service';
import defaultHelper from './default-fn';

export * from './service';

export default class Application {
  private service = new TaskService('app-service');

  start(): boolean {
    defaultHelper('init');
    return this.service.handle('initial-task');
  }
}
