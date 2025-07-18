/*
	Spacebar: A FOSS re-implementation and extension of the Discord.com backend.
	Copyright (C) 2023 Spacebar and Spacebar Contributors
	
	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published
	by the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.
	
	You should have received a copy of the GNU Affero General Public License
	along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Payload, WebSocket } from "@spacebar/gateway";
import {
	Config,
	emitEvent,
	Guild,
	Member,
	Region,
	VoiceServerUpdateEvent,
	VoiceState,
	VoiceStateUpdateEvent,
	VoiceStateUpdateSchema,
} from "@spacebar/util";
import { genVoiceToken } from "../util/SessionUtils";
import { check } from "./instanceOf";
// TODO: check if a voice server is setup

// Notice: Bot users respect the voice channel's user limit, if set.
// When the voice channel is full, you will not receive the Voice State Update or Voice Server Update events in response to your own Voice State Update.
// Having MANAGE_CHANNELS permission bypasses this limit and allows you to join regardless of the channel being full or not.

export async function onVoiceStateUpdate(this: WebSocket, data: Payload) {
	const startTime = Date.now();
	check.call(this, VoiceStateUpdateSchema, data.d);
	const body = data.d as VoiceStateUpdateSchema;
	const isNew = body.channel_id === null && body.guild_id === null;
	let isChanged = false;

	let prevState;

	let voiceState: VoiceState;
	try {
		voiceState = await VoiceState.findOneOrFail({
			where: { user_id: this.user_id },
		});
		if (
			voiceState.session_id !== this.session_id &&
			body.channel_id === null
		) {
			//Should we also check guild_id === null?
			//changing deaf or mute on a client that's not the one with the same session of the voicestate in the database should be ignored
			return;
		}

		if (voiceState.channel_id !== body.channel_id) isChanged = true;

		//If a user change voice channel between guild we should send a left event first
		if (
			voiceState.guild_id &&
			voiceState.guild_id !== body.guild_id &&
			voiceState.session_id === this.session_id
		) {
			await emitEvent({
				event: "VOICE_STATE_UPDATE",
				data: { ...voiceState.toPublicVoiceState(), channel_id: null },
				guild_id: voiceState.guild_id,
			});
		}

		//The event send by Discord's client on channel leave has both guild_id and channel_id as null
		//if (body.guild_id === null) body.guild_id = voiceState.guild_id;
		prevState = { ...voiceState };
		voiceState.assign(body);
	} catch (error) {
		voiceState = VoiceState.create({
			...body,
			user_id: this.user_id,
			deaf: false,
			mute: false,
			suppress: false,
		});
	}

	// if user left voice channel, send an update to previous channel/guild to let other people know that the user left
	if (
		voiceState.session_id === this.session_id &&
		body.guild_id == null &&
		body.channel_id == null &&
		(prevState?.guild_id || prevState?.channel_id)
	) {
		await emitEvent({
			event: "VOICE_STATE_UPDATE",
			data: {
				...voiceState.toPublicVoiceState(),
				channel_id: null,
				guild_id: null,
			},
			guild_id: prevState?.guild_id,
			channel_id: prevState?.channel_id,
		});
	}

	//TODO the member should only have these properties: hoisted_role, deaf, joined_at, mute, roles, user
	//TODO the member.user should only have these properties: avatar, discriminator, id, username
	//TODO this may fail
	if (body.guild_id) {
		voiceState.member = await Member.findOneOrFail({
			where: { id: voiceState.user_id, guild_id: voiceState.guild_id },
			relations: ["user", "roles"],
		});
	}

	//If the session changed we generate a new token
	if (voiceState.session_id !== this.session_id)
		voiceState.token = genVoiceToken();
	voiceState.session_id = this.session_id;

	const { member } = voiceState;

	await Promise.all([
		voiceState.save(),
		emitEvent({
			event: "VOICE_STATE_UPDATE",
			data: {
				...voiceState.toPublicVoiceState(),
				member: member?.toPublicMember(),
			},
			guild_id: voiceState.guild_id,
			channel_id: voiceState.channel_id,
			user_id: voiceState.user_id,
		} as VoiceStateUpdateEvent),
	]);

	//If it's null it means that we are leaving the channel and this event is not needed
	if ((isNew || isChanged) && voiceState.channel_id !== null) {
		const guild = await Guild.findOne({
			where: { id: voiceState.guild_id },
		});
		const regions = Config.get().regions;
		let guildRegion: Region;
		if (guild && guild.region) {
			guildRegion = regions.available.filter(
				(r) => r.id === guild.region,
			)[0];
		} else {
			guildRegion = regions.available.filter(
				(r) => r.id === regions.default,
			)[0];
		}

		await emitEvent({
			event: "VOICE_SERVER_UPDATE",
			data: {
				token: voiceState.token,
				guild_id: voiceState.guild_id,
				endpoint: guildRegion.endpoint,
				channel_id: voiceState.guild_id
					? undefined
					: voiceState.channel_id, // only DM voice calls have this set, and DM channel is one where guild_id is null
			},
			user_id: voiceState.user_id,
		} as VoiceServerUpdateEvent);
	}

	console.log(
		`[Gateway] VOICE_STATE_UPDATE for user ${this.user_id} in channel ${voiceState.channel_id} in guild ${voiceState.guild_id} in ${Date.now() - startTime}ms`,
	);
}
