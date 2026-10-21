import { resetDismissalStoreForTests } from "../../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../../modules/ui/notifications.ts";

export function resetNotificationState(): void {
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
	resetDismissalStoreForTests();
}
