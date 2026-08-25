export const STATUSES = ['new', 'contacted', 'responded', 'converted', 'dead'] as const;
export type LeadStatus = (typeof STATUSES)[number];

export const SOURCES = ['zillow', 'realtor', 'redfin', 'homes', 'airbnb', 'manual', 'csv'] as const;
export type LeadSource = (typeof SOURCES)[number];

export interface Lead {
  id: number;
  source: LeadSource;
  external_id: string | null;
  listing_url: string | null;
  sources: string[];
  external_ids: Record<string, string>;
  times_seen: number;
  last_seen_at: string;
  address: string;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  property_type: string | null;
  photo_urls: string[];
  agent_name: string | null;
  agent_email: string | null;
  agent_phone: string | null;
  status: LeadStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Stats {
  total: number;
  by_status: Record<string, number>;
  by_source: Record<string, number>;
}

export interface LeadFilters {
  status?: string;
  source?: string;
  min_price?: string;
  max_price?: string;
  search?: string;
}
