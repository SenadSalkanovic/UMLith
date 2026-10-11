import { logInfo } from '../utils/logger';

export function sendEmailNotification(to: string, subject: string, body: string): boolean {
  logInfo(`Email sent to ${to}: ${subject}`);
  return true;
}

export function notifyOrderPlaced(orderId: number, customerEmail: string): void {
  sendEmailNotification(customerEmail, 'Order Placed', `Your order #${orderId} was confirmed.`);
}
