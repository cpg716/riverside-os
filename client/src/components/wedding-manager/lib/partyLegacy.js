/** Matches `wedding_parties.party_type` for older single-customer parties (WM creation path removed). */
export const LEGACY_INDIVIDUAL_PARTY_TYPE = "Order";

export function isLegacyIndividualParty(party) {
  return party?.type === LEGACY_INDIVIDUAL_PARTY_TYPE;
}
