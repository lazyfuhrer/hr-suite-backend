import { dispatchNotificationEvent } from './notification-dispatcher.service';

export async function notifyGeofenceEvent(args: {
  orgId: string;
  userId: string;
  geofenceId: string;
  geofenceEventId: string;
  eventType: 'in' | 'out';
  landmark: string;
  deviceToken?: string;
  platform?: 'apns' | 'gcm' | 'web';
}): Promise<void> {
  const entered = args.eventType === 'in';
  const title = entered ? 'Geofence entered' : 'Geofence exited';
  const body = entered ? `You entered ${args.landmark}.` : `You left ${args.landmark}.`;
  const data: Record<string, string> = {
    geofenceId: args.geofenceId,
    geofenceEventId: args.geofenceEventId,
    eventType: args.eventType,
    landmark: args.landmark,
  };
  if (args.platform) {
    data.platform = args.platform;
  }
  const event = entered ? 'geofence.in' : 'geofence.out';

  if (args.deviceToken) {
    await dispatchNotificationEvent({
      event,
      scope: 'tokens',
      orgId: args.orgId,
      tokens: [args.deviceToken],
      title,
      body,
      data,
    });
    return;
  }

  await dispatchNotificationEvent({
    event,
    scope: 'user',
    orgId: args.orgId,
    userIds: [args.userId],
    title,
    body,
    data,
  });
}
