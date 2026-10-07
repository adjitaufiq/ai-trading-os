export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      assistant_messages: {
        Row: {
          created_at: string
          id: string
          parts: Json
          role: string
          sdk_id: string
          thread_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parts?: Json
          role: string
          sdk_id: string
          thread_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parts?: Json
          role?: string
          sdk_id?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistant_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "assistant_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      assistant_threads: {
        Row: {
          created_at: string
          id: string
          symbol: string | null
          title: string
          topic: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          symbol?: string | null
          title?: string
          topic?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          symbol?: string | null
          title?: string
          topic?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      demo_execution_control: {
        Row: {
          id: number
          reason: string | null
          stopped: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: number
          reason?: string | null
          stopped?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: number
          reason?: string | null
          stopped?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      demo_execution_control_log: {
        Row: {
          changed_at: string
          changed_by: string | null
          id: string
          reason: string | null
          stopped: boolean
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          reason?: string | null
          stopped: boolean
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          reason?: string | null
          stopped?: boolean
        }
        Relationships: []
      }
      engine_access_audit: {
        Row: {
          action: string
          actor_id: string | null
          actor_role: string
          created_at: string
          detail: Json
          id: string
          scope: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_role: string
          created_at?: string
          detail?: Json
          id?: string
          scope: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_role?: string
          created_at?: string
          detail?: Json
          id?: string
          scope?: string
        }
        Relationships: []
      }
      engine_events: {
        Row: {
          block_reason: string | null
          captured_at: string
          confidence: number | null
          direction: string | null
          entry: number | null
          event_key: string
          event_type: string
          execution_result: string | null
          id: string
          occurred_at: string
          payload: Json
          reason: string
          signal_id: string | null
          snapshot_ref: string | null
          source: string
          stage: string | null
          stop_loss: number | null
          symbol: string
          take_profit: number | null
          timeframe_context: Json
        }
        Insert: {
          block_reason?: string | null
          captured_at?: string
          confidence?: number | null
          direction?: string | null
          entry?: number | null
          event_key: string
          event_type: string
          execution_result?: string | null
          id?: string
          occurred_at: string
          payload?: Json
          reason?: string
          signal_id?: string | null
          snapshot_ref?: string | null
          source?: string
          stage?: string | null
          stop_loss?: number | null
          symbol: string
          take_profit?: number | null
          timeframe_context?: Json
        }
        Update: {
          block_reason?: string | null
          captured_at?: string
          confidence?: number | null
          direction?: string | null
          entry?: number | null
          event_key?: string
          event_type?: string
          execution_result?: string | null
          id?: string
          occurred_at?: string
          payload?: Json
          reason?: string
          signal_id?: string | null
          snapshot_ref?: string | null
          source?: string
          stage?: string | null
          stop_loss?: number | null
          symbol?: string
          take_profit?: number | null
          timeframe_context?: Json
        }
        Relationships: []
      }
      engine_memory: {
        Row: {
          active_events: string[]
          approach: string | null
          bias: string | null
          captured_at: string
          confidence: number | null
          confirmation_needed: string[]
          data_source: string | null
          decision: string | null
          engine_state: string | null
          h1_state: string | null
          h4_state: string | null
          horizon: string[]
          id: string
          invalidation: string[]
          m5_close_at: string
          market_phase: string | null
          price: number | null
          radar_status: string | null
          reasons: string[]
          regime: string | null
          resistance: number | null
          risk: string | null
          setup: string | null
          support: number | null
          symbol: string
        }
        Insert: {
          active_events?: string[]
          approach?: string | null
          bias?: string | null
          captured_at?: string
          confidence?: number | null
          confirmation_needed?: string[]
          data_source?: string | null
          decision?: string | null
          engine_state?: string | null
          h1_state?: string | null
          h4_state?: string | null
          horizon?: string[]
          id?: string
          invalidation?: string[]
          m5_close_at: string
          market_phase?: string | null
          price?: number | null
          radar_status?: string | null
          reasons?: string[]
          regime?: string | null
          resistance?: number | null
          risk?: string | null
          setup?: string | null
          support?: number | null
          symbol: string
        }
        Update: {
          active_events?: string[]
          approach?: string | null
          bias?: string | null
          captured_at?: string
          confidence?: number | null
          confirmation_needed?: string[]
          data_source?: string | null
          decision?: string | null
          engine_state?: string | null
          h1_state?: string | null
          h4_state?: string | null
          horizon?: string[]
          id?: string
          invalidation?: string[]
          m5_close_at?: string
          market_phase?: string | null
          price?: number | null
          radar_status?: string | null
          reasons?: string[]
          regime?: string | null
          resistance?: number | null
          risk?: string | null
          setup?: string | null
          support?: number | null
          symbol?: string
        }
        Relationships: []
      }
      engine_notifications: {
        Row: {
          attempted_at: string
          channel: string
          delivery_status: string
          event_id: string
          id: string
          note: string | null
        }
        Insert: {
          attempted_at?: string
          channel?: string
          delivery_status: string
          event_id: string
          id?: string
          note?: string | null
        }
        Update: {
          attempted_at?: string
          channel?: string
          delivery_status?: string
          event_id?: string
          id?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "engine_notifications_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "engine_events"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_trades: {
        Row: {
          approach: string | null
          captured_at: string
          close_reason: string | null
          closed_at: string
          data_source: string | null
          direction: string
          failure_category: string | null
          location: string | null
          opened_at: string
          payload: Json
          profit_loss_usd: number
          r_multiple: number | null
          reaction_quality: string | null
          regime: string | null
          result: string
          risk_usd: number
          symbol: string
          trade_id: string
          trigger_pattern: string | null
        }
        Insert: {
          approach?: string | null
          captured_at?: string
          close_reason?: string | null
          closed_at: string
          data_source?: string | null
          direction: string
          failure_category?: string | null
          location?: string | null
          opened_at: string
          payload: Json
          profit_loss_usd: number
          r_multiple?: number | null
          reaction_quality?: string | null
          regime?: string | null
          result: string
          risk_usd: number
          symbol: string
          trade_id: string
          trigger_pattern?: string | null
        }
        Update: {
          approach?: string | null
          captured_at?: string
          close_reason?: string | null
          closed_at?: string
          data_source?: string | null
          direction?: string
          failure_category?: string | null
          location?: string | null
          opened_at?: string
          payload?: Json
          profit_loss_usd?: number
          r_multiple?: number | null
          reaction_quality?: string | null
          regime?: string | null
          result?: string
          risk_usd?: number
          symbol?: string
          trade_id?: string
          trigger_pattern?: string | null
        }
        Relationships: []
      }
      execution_agent_status: {
        Row: {
          account_mode: string | null
          account_number_masked: string | null
          agent_id: string
          agent_online: boolean
          broker_server: string | null
          created_at: string
          current_version: string | null
          execution_mode: string | null
          id: string
          last_error: string | null
          last_heartbeat: string | null
          mt5_connected: boolean
          open_positions: number | null
          updated_at: string
        }
        Insert: {
          account_mode?: string | null
          account_number_masked?: string | null
          agent_id: string
          agent_online?: boolean
          broker_server?: string | null
          created_at?: string
          current_version?: string | null
          execution_mode?: string | null
          id?: string
          last_error?: string | null
          last_heartbeat?: string | null
          mt5_connected?: boolean
          open_positions?: number | null
          updated_at?: string
        }
        Update: {
          account_mode?: string | null
          account_number_masked?: string | null
          agent_id?: string
          agent_online?: boolean
          broker_server?: string | null
          created_at?: string
          current_version?: string | null
          execution_mode?: string | null
          id?: string
          last_error?: string | null
          last_heartbeat?: string | null
          mt5_connected?: boolean
          open_positions?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      execution_audit_log: {
        Row: {
          changed_by: string | null
          event_type: string
          id: string
          metadata: Json
          new_value: Json | null
          old_value: Json | null
          source: string
          timestamp: string
        }
        Insert: {
          changed_by?: string | null
          event_type: string
          id?: string
          metadata?: Json
          new_value?: Json | null
          old_value?: Json | null
          source: string
          timestamp?: string
        }
        Update: {
          changed_by?: string | null
          event_type?: string
          id?: string
          metadata?: Json
          new_value?: Json | null
          old_value?: Json | null
          source?: string
          timestamp?: string
        }
        Relationships: []
      }
      execution_config: {
        Row: {
          allowed_symbols: string[]
          created_at: string
          demo_enabled: boolean
          execution_mode: string
          id: number
          kill_switch: boolean
          max_daily_loss_percent: number
          max_daily_trades: number
          max_open_positions: number
          risk_percent: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allowed_symbols?: string[]
          created_at?: string
          demo_enabled?: boolean
          execution_mode?: string
          id?: number
          kill_switch?: boolean
          max_daily_loss_percent?: number
          max_daily_trades?: number
          max_open_positions?: number
          risk_percent?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allowed_symbols?: string[]
          created_at?: string
          demo_enabled?: boolean
          execution_mode?: string
          id?: number
          kill_switch?: boolean
          max_daily_loss_percent?: number
          max_daily_trades?: number
          max_open_positions?: number
          risk_percent?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      trade_reviews: {
        Row: {
          compliance: Json
          compliance_status: string
          created_at: string
          created_by: string
          facts: Json
          id: string
          model: string | null
          narrative: string
          review_version: string
          symbol: string
          trade_id: string
        }
        Insert: {
          compliance: Json
          compliance_status: string
          created_at?: string
          created_by: string
          facts: Json
          id?: string
          model?: string | null
          narrative: string
          review_version: string
          symbol: string
          trade_id: string
        }
        Update: {
          compliance?: Json
          compliance_status?: string
          created_at?: string
          created_by?: string
          facts?: Json
          id?: string
          model?: string | null
          narrative?: string
          review_version?: string
          symbol?: string
          trade_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_reviews_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "engine_trades"
            referencedColumns: ["trade_id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_engine_operator: { Args: { _user_id: string }; Returns: boolean }
      log_engine_access: {
        Args: { _detail?: Json; _scope: string }
        Returns: undefined
      }
      update_execution_config: {
        Args: { _patch: Json }
        Returns: {
          allowed_symbols: string[]
          created_at: string
          demo_enabled: boolean
          execution_mode: string
          id: number
          kill_switch: boolean
          max_daily_loss_percent: number
          max_daily_trades: number
          max_open_positions: number
          risk_percent: number
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "execution_config"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      app_role: "admin" | "operator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operator", "user"],
    },
  },
} as const
