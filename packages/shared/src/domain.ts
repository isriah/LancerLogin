export type Id = string;
export type IsoTimestamp = string;

export type AuthMode = "google" | "local" | "both";
export type SetupStep =
  | "branding"
  | "roster"
  | "pair-kiosk"
  | "fingerprint-test"
  | "test-meeting"
  | "confirm-attendance";

export interface OrganizationBranding {
  organizationName: string;
  subtitle?: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  appearance: "system" | "light" | "dark";
}

export interface Principal {
  userId: Id;
  role: "admin" | "operator";
}

export interface Meeting {
  id: Id;
  title: string;
  startsAt: IsoTimestamp;
  endsAt?: IsoTimestamp;
  required: boolean;
}

export interface AttendanceCorrection {
  id: Id;
  memberId: Id;
  meetingId: Id;
  disposition: "present" | "absent" | "excused";
  reason: string;
  createdBy: Id;
  createdAt: IsoTimestamp;
}
