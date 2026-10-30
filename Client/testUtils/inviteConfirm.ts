import type TestRenderer from "react-test-renderer";
import { act } from "react-test-renderer";
import { TEST_IDS } from "../app/utils/testIds";

// The waiting room's invite dialog (InviteConfirmModal, DEC-046): an invite link joins nothing until Join.

type Renderer = TestRenderer.ReactTestRenderer;

const pressable = (r: Renderer, testID: string) =>
  r.root.find((n) => n.props.testID === testID && typeof n.props.onPress === "function");

/** Whether the invite dialog is on screen. */
export const showsInviteDialog = (r: Renderer) =>
  r.root.findAll((n) => n.props.testID === TEST_IDS.inviteConfirmModal).length > 0;

/** The name field's composite TextInput (value, onChangeText). */
export const inviteNameInput = (r: Renderer) =>
  r.root.find((n) => n.props.testID === TEST_IDS.inviteNameInput && typeof n.props.onChangeText === "function");

/** Whether Join can be pressed (a name is typed and no join is being checked). */
export const inviteJoinEnabled = (r: Renderer) => !pressable(r, TEST_IDS.inviteJoinButton).props.disabled;

/** Types `name` into the dialog's name field (replacing what it held). */
export const typeInviteName = (r: Renderer, name: string) =>
  act(() => { inviteNameInput(r).props.onChangeText(name); });

/** Taps Join and waits for it to settle (the gallery check included). */
export const pressInviteJoin = (r: Renderer) =>
  act(async () => { await pressable(r, TEST_IDS.inviteJoinButton).props.onPress(); });

/** Taps Cancel. */
export const pressInviteCancel = (r: Renderer) =>
  act(() => { pressable(r, TEST_IDS.inviteCancelButton).props.onPress(); });
