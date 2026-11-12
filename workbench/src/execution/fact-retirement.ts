import {
  ControlTransportError,
  type ControlExchange,
} from "./control-request.js";

export interface FactRetirement {
  viewId: string;
  entityId: string;
  fields: string[];
  minimumBirthSequence: number;
}
export interface FactRetirementReceipt {
  kind: string;
  status: string;
  reason: string;
  control: FactRetirement;
  floors: Record<string, number>;
}

/** Equal-floor retries are safe; a policy rejection or mismatched acknowledgement is fatal. */
export async function retireAndCheckReceipt(
  exchange: ControlExchange,
  control: FactRetirement,
) {
  let receipt: FactRetirementReceipt;
  try {
    receipt = (await exchange(
      "/facts/retire",
      control,
    )) as FactRetirementReceipt;
  } catch (error) {
    if (!(error instanceof ControlTransportError)) throw error;
    receipt = (await exchange(
      "/facts/retire",
      control,
    )) as FactRetirementReceipt;
  }
  const echoed = receipt?.control;
  const sameFields = (fields: string[] | undefined) =>
    fields?.length === control.fields.length &&
    control.fields.every((field) => fields.includes(field));
  if (
    receipt?.kind !== "factRetirement" ||
    !["committed", "unchanged"].includes(receipt.status) ||
    echoed?.viewId !== control.viewId ||
    echoed?.entityId !== control.entityId ||
    echoed?.minimumBirthSequence !== control.minimumBirthSequence ||
    !sameFields(echoed?.fields) ||
    !sameFields(Object.keys(receipt.floors ?? {})) ||
    control.fields.some(
      (field) => receipt.floors[field] !== control.minimumBirthSequence,
    )
  ) {
    throw new Error(
      `Fact retirement failed for ${control.viewId}/${control.entityId}: ${JSON.stringify(receipt)}`,
    );
  }
  return receipt;
}
