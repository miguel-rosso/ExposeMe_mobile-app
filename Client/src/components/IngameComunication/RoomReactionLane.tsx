import React, { memo, useCallback, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import EmojiReactionLane from "./EmojiReactionLane";
import { attachHandlers } from "../../utils/socketHandlers";
import {
  appendAllCapped, appendCapped, MAX_VISIBLE_REACTIONS, reactionsOn, RoomReaction, roomReactionOf, withoutReaction,
} from "../../utils/reactions";

const NO_REACTIONS: RoomReaction[] = [];

interface RoomReactionsOptions {
  socket: Socket | null | undefined;
  // False once the game is over: later reactions are not shown
  listening: boolean;
  // The round photo on screen (null while there is none)
  photo: string | null;
  // The photo the server sent last, read as each reaction arrives: ahead of `photo` from the event that changes it
  // until the screen renders the change, so a reaction arriving in between is kept for the new photo
  latestPhoto: () => string | null;
}

/**
 * The room's emoji reactions on the photo on screen: the newest few, each until its animation ends. Arrivals are
 * shown once per frame (a burst is a single render), and a reaction ending after newer ones pushed it out changes
 * nothing.
 */
export function useRoomReactions({ socket, listening, photo, latestPhoto }: RoomReactionsOptions) {
  const [reactions, setReactions] = useState<RoomReaction[]>(NO_REACTIONS);
  // Reactions belong to the photo they were sent on: when the photo on screen changes, the others are dropped in
  // that same render (waiting-photo, resume, snapshot), not in an extra one after it
  const [reactionsPhoto, setReactionsPhoto] = useState(photo);
  if (photo !== reactionsPhoto) {
    setReactionsPhoto(photo);
    setReactions((list) => reactionsOn(list, photo));
  }

  useEffect(() => {
    if (!socket || !listening) return;
    let arrived: RoomReaction[] = [];
    let frame: number | null = null;
    const showArrived = () => {
      frame = null;
      const batch = arrived;
      arrived = [];
      setReactions((list) => appendAllCapped(list, batch, MAX_VISIBLE_REACTIONS));
    };
    const detach = attachHandlers(socket, {
      // Only the picker's emojis (and the screenshot one), only while a photo is shown, at most a few on screen
      "emoji-reaction": (data: unknown) => {
        const reaction = roomReactionOf(data, latestPhoto());
        if (!reaction) return;
        arrived = appendCapped(arrived, reaction, MAX_VISIBLE_REACTIONS);
        frame ??= requestAnimationFrame(showArrived);
      },
    });
    return () => {
      detach();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [socket, listening, latestPhoto]);

  const removeReaction = useCallback((id: string) => setReactions((list) => withoutReaction(list, id)), []);
  // Some may already be for the next photo, not on screen yet
  return { reactions: reactionsOn(reactions, photo), removeReaction };
}

interface RoomReactionLaneProps extends RoomReactionsOptions {
  // Lane start (px from the top of the game screen) and the answer buttons' top edge, see EmojiReactionLane
  top: number;
  answersTop: number | null;
  screenshotLabel: string;
}

// The reaction lane with its own state and listener: a reaction re-renders this lane only, never the game screen
// (EXP-393). Mounted for the whole game, so no reaction is lost while the photo changes; drawn only over a photo.
const RoomReactionLane: React.FC<RoomReactionLaneProps> = ({ socket, listening, photo, latestPhoto, ...lane }) => {
  const { reactions, removeReaction } = useRoomReactions({ socket, listening, photo, latestPhoto });
  if (!photo) return null;
  return <EmojiReactionLane {...lane} reactions={reactions} onReactionEnd={removeReaction} />;
};

export default memo(RoomReactionLane);
