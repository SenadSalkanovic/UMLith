export class UserService {
  public getUser(id: string): { id: string; name: string } {
    return { id, name: 'Alice' };
  }
}
