'use strict';

const validator = require('validator');
const winston = require('winston');

const db = require('../database');
const user = require('../user');
const meta = require('../meta');
const messaging = require('../messaging');
const notifications = require('../notifications');
const plugins = require('../plugins');
const utils = require('../utils');

const socketHelpers = require('../socket.io/helpers');

const chatsAPI = module.exports;

async function rateLimitExceeded(caller, field) {
	const session = caller.request ? caller.request.session : caller.session; // socket vs req
	const now = Date.now();
	const [isPrivileged, reputation] = await Promise.all([
		user.isPrivileged(caller.uid),
		user.getUserField(caller.uid, 'reputation'),
	]);
	const newbie = !isPrivileged && meta.config.newbieReputationThreshold > reputation;
	const delay = newbie ? meta.config.newbieChatMessageDelay : meta.config.chatMessageDelay;
	session[field] = session[field] || 0;

	if (now - session[field] < delay) {
		return true;
	}

	session[field] = now;
	return false;
}

chatsAPI.list = async (caller, { uid = caller.uid, start, stop, page, perPage } = {}) => {
	if ((!utils.isNumber(start) || !utils.isNumber(stop)) && !utils.isNumber(page)) {
		throw new Error('[[error:invalid-data]]');
	}

	if (!start && !stop && page) {
		winston.warn('[api/chats] Sending `page` and `perPage` to .list() is deprecated in favour of `start` and `stop`. The deprecated parameters will be removed in v4.');
		start = Math.max(0, page - 1) * perPage;
		stop = start + perPage - 1;
	}

	return await messaging.getRecentChats(caller.uid, uid || caller.uid, start, stop);
};

chatsAPI.create = async function (caller, data) {
	if (await rateLimitExceeded(caller, 'lastChatRoomCreateTime')) {
		throw new Error('[[error:too-many-messages]]');
	}
	if (!data) {
		throw new Error('[[error:invalid-data]]');
	}

	const isPublic = data.type === 'public';
	const isAdmin = await user.isAdministrator(caller.uid);
	if (isPublic && !isAdmin) {
		throw new Error('[[error:no-privileges]]');
	}

	if (!data.uids || !Array.isArray(data.uids)) {
		throw new Error(`[[error:wrong-parameter-type, uids, ${typeof data.uids}, Array]]`);
	}

	if (!isPublic && !data.uids.length) {
		throw new Error('[[error:no-users-selected]]');
	}
	if (isPublic && (!Array.isArray(data.groups) || !data.groups.length)) {
		throw new Error('[[error:no-groups-selected]]');
	}

	data.notificationSetting = isPublic ?
		messaging.notificationSettings.ATMENTION :
		messaging.notificationSettings.ALLMESSAGES;

	await Promise.all(data.uids.map(uid => messaging.canMessageUser(caller.uid, uid)));
	const roomId = await messaging.newRoom(caller.uid, data);

	return await messaging.getRoomData(roomId);
};

chatsAPI.getUnread = async (caller) => {
	const count = await messaging.getUnreadCount(caller.uid);
	return { count };
};

chatsAPI.sortPublicRooms = async (caller, { roomIds, scores }) => {
	[roomIds, scores].forEach((arr) => {
		if (!Array.isArray(arr) || !arr.every(value => isFinite(value))) {
			throw new Error('[[error:invalid-data]]');
		}
	});

	const isAdmin = await user.isAdministrator(caller.uid);
	if (!isAdmin) {
		throw new Error('[[error:no-privileges]]');
	}

	await db.sortedSetAdd(`chat:rooms:public:order`, scores, roomIds);
	require('../cache').del(`chat:rooms:public:order:all`);
};

chatsAPI.get = async (caller, { uid, roomId }) => await messaging.loadRoom(caller.uid, { uid, roomId });

chatsAPI.post = async (caller, data) => {
	if (await rateLimitExceeded(caller, 'lastChatMessageTime')) {
		throw new Error('[[error:too-many-messages]]');
	}
	if (!data || !data.roomId || !caller.uid) {
		throw new Error('[[error:invalid-data]]');
	}

	({ data } = await plugins.hooks.fire('filter:messaging.send', {
		data,
		uid: caller.uid,
	}));

	await messaging.canMessageRoom(caller.uid, data.roomId);
	const message = await messaging.sendMessage({
		uid: caller.uid,
		roomId: data.roomId,
		content: data.message,
		toMid: data.toMid,
		timestamp: Date.now(),
		ip: caller.ip,
	});
	messaging.notifyUsersInRoom(caller.uid, data.roomId, message);
	user.updateOnlineUsers(caller.uid);

	return message;
};

// Used Chat GPT to edit this function
chatsAPI.update = async (caller, data) => {
	validateInput(data);

	if (data.hasOwnProperty('name')) {
		await renameRoom(caller.uid, data.roomId, data.name);
	}

	const [roomData, isAdmin] = await fetchRoomDataAndAdminStatus(caller.uid, data.roomId);

	if (data.hasOwnProperty('groups') && isAdmin && roomData.public) {
		await updateRoomGroups(data.roomId, data.groups);
	}

	if (data.hasOwnProperty('notificationSetting') && isAdmin) {
		await updateNotificationSetting(data.roomId, data.notificationSetting);
	}

	const loadedRoom = await messaging.loadRoom(caller.uid, { roomId: data.roomId });

	if (data.hasOwnProperty('name')) {
		emitRoomRenameEvent(data.roomId, data.name, loadedRoom);
	}

	return loadedRoom;
};

function validateInput(data) {
	if (!data || !data.roomId) {
		throw new Error('[[error:invalid-data]]');
	}
}

async function renameRoom(userId, roomId, name) {
	if (!name && name !== '') {
		throw new Error('[[error:invalid-data]]');
	}
	await messaging.renameRoom(userId, roomId, name);
}

async function fetchRoomDataAndAdminStatus(userId, roomId) {
	const [roomData, isAdmin] = await Promise.all([
		messaging.getRoomData(roomId),
		user.isAdministrator(userId),
	]);

	if (!roomData) {
		throw new Error('[[error:invalid-data]]');
	}

	return [roomData, isAdmin];
}

async function updateRoomGroups(roomId, groups) {
	await db.setObjectField(`chat:room:${roomId}`, 'groups', JSON.stringify(groups));
}

async function updateNotificationSetting(roomId, notificationSetting) {
	await db.setObjectField(`chat:room:${roomId}`, 'notificationSetting', notificationSetting);
}

function emitRoomRenameEvent(roomId, name, loadedRoom) {
	const ioRoom = require('../socket.io').in(`chat_room_${roomId}`);
	if (ioRoom) {
		ioRoom.emit('event:chats.roomRename', {
			roomId: roomId,
			newName: validator.escape(String(name)),
			chatWithMessage: loadedRoom.chatWithMessage,
		});
	}
}

chatsAPI.rename = async (caller, data) => {
	if (!data || !data.roomId || !data.name) {
		throw new Error('[[error:invalid-data]]');
	}
	return await chatsAPI.update(caller, data);
};

chatsAPI.mark = async (caller, data) => {
	if (!caller.uid || !data || !data.roomId) {
		throw new Error('[[error:invalid-data]]');
	}
	const { roomId, state } = data;
	if (state) {
		await messaging.markUnread([caller.uid], roomId);
	} else {
		await messaging.markRead(caller.uid, roomId);
		socketHelpers.emitToUids('event:chats.markedAsRead', { roomId: roomId }, [caller.uid]);
		const nids = await user.notifications.getUnreadByField(caller.uid, 'roomId', [roomId]);
		await notifications.markReadMultiple(nids, caller.uid);
		user.notifications.pushCount(caller.uid);
	}

	socketHelpers.emitToUids('event:chats.mark', { roomId, state }, [caller.uid]);
	messaging.pushUnreadCount(caller.uid);
};

chatsAPI.watch = async (caller, { roomId, state }) => {
	const inRoom = await messaging.isUserInRoom(caller.uid, roomId);
	if (!inRoom) {
		throw new Error('[[error:no-privileges]]');
	}

	await messaging.setUserNotificationSetting(caller.uid, roomId, state);
	socketHelpers.emitToUids('event:chats.watch', { roomId, state }, [caller.uid]);
};

chatsAPI.delete = async (caller, data) => {
	if (!data || !data.roomId) {
		throw new Error('[[error:invalid-data]]');
	}

	const isAdmin = await user.isAdministrator(caller.uid);
	const roomData = await messaging.getRoomData(data.roomId);

	if (roomData.public && !isAdmin) {
		throw new Error('[[error:no-privileges]]');
	}

	await messaging.deleteRoom(data.roomId);

	socketHelpers.emitToUids('event:chats.deleted', { roomId: data.roomId }, [caller.uid]);
};

chatsAPI.getMembers = async (caller, { roomId }) => {
	if (!roomId) {
		throw new Error('[[error:invalid-data]]');
	}

	const roomData = await messaging.getRoomData(roomId);
	if (!roomData) {
		throw new Error('[[error:invalid-data]]');
	}

	const members = await messaging.getRoomMembers(roomId);
	return { members };
};

chatsAPI.join = async (caller, { roomId }) => {
	if (!roomId) {
		throw new Error('[[error:invalid-data]]');
	}

	const canJoin = await messaging.canJoinRoom(caller.uid, roomId);
	if (!canJoin) {
		throw new Error('[[error:no-privileges]]');
	}

	await messaging.addUserToRoom(caller.uid, roomId);
	socketHelpers.emitToUids('event:chats.joined', { roomId, uid: caller.uid }, [caller.uid]);
};

chatsAPI.leave = async (caller, { roomId }) => {
	if (!roomId) {
		throw new Error('[[error:invalid-data]]');
	}

	const canLeave = await messaging.canLeaveRoom(caller.uid, roomId);
	if (!canLeave) {
		throw new Error('[[error:no-privileges]]');
	}

	await messaging.removeUserFromRoom(caller.uid, roomId);
	socketHelpers.emitToUids('event:chats.left', { roomId, uid: caller.uid }, [caller.uid]);
};

chatsAPI.getRoomData = async (caller, { roomId }) => {
	if (!roomId) {
		throw new Error('[[error:invalid-data]]');
	}

	const roomData = await messaging.getRoomData(roomId);
	if (!roomData) {
		throw new Error('[[error:invalid-data]]');
	}

	return roomData;
};

