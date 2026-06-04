import { ActionItem, ChatThread, ComplianceLog, Participant } from './types';

export const initialParticipants: Participant[] = [
  {
    id: 'sarah',
    name: 'Sarah Chen',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCo0kLj3Le2eR0OMi0N1rZg3lR45flPJAdiOCpAF7lv_WWBnPgafvQ14CPTsRzZZs1Gw1pR0IhMEe_7y0MkuX2-9oC4_jqXbwtzsWsCWYHaWeQgfMoieTDggvn5qXuk5u8Dl0xr8neI62Aj4Khe6mYrHLO81crS_Mp2D0bKNspkEAHOvelfxfLGsj2nzUMCCBMH_42wSr38sxELoPouq3xwzl8k8Y3lWBJlPH67a3iiMkA7YJdLeOEnHB7JcoIlQ6AjM5wrxH3j0Ngg',
    status: 'Confident',
    isSpeaking: true,
    isMuted: false,
    dataAlt: 'A woman in a modern office environment, speaking on a video call. Bright, natural lighting. Enterprise futuristic style.'
  },
  {
    id: 'marcus',
    name: 'Marcus Thorne',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDDnU7odt7LmTnVMom2mFbxQvT0dzKKk06gVmGpUEjMVUhlaI_MuuxVP9xLlKCGs0P1WtCvTdasWrvBiEWPN2DDWwCMYLQS_5BDaeXp4z6XUzZMHdR0IcWSce_v4CmgWwKkVxoBPDJFfjXZm4yWRa7mNF-v8AiIuPgZf8e0WIAzUX8itrzNghwIqHfMAyGdRQaYqrycqytSJGSpW6khk6UOdKnPpLXWkEM8Jememlxf1ShTTzByxZKi1e_-IpsZsPmMFZG_a_R7ZyP4',
    status: '',
    isSpeaking: false,
    isMuted: true,
    dataAlt: 'A man in a modern office environment, listening on a video call. Bright, natural lighting. Enterprise futuristic style.'
  },
  {
    id: 'elena',
    name: 'Elena Rostova',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDLRKlPgkxN4lpnLkJJZ5TQjA3B51BgvRj2PW3KnnZT98n8awwH6If-h4cJqbivE9eVzvg8UYXY2udE3ZylCrCFzThymTkm5pC5uRVsrZVia9wuol2HVO_pWWlTHVdWyjVTpJlxyglSig1lGX6_taK-Ubv6mhbt9Sz1M0f36iFI34cn1q6qr7ZxOo_QotsHiCwwhzX0L5KXEe0m8pLw2LS5wU9NlB0bZW4kljye5ha3z9af9xNaPiCCOIWluINlRy9xMiL92GhIOdBr',
    status: 'Low Light',
    isSpeaking: false,
    isMuted: false,
    dataAlt: 'A woman in a minimalist home office, looking at the screen. Soft, natural lighting. Modern minimalistic style.'
  },
  {
    id: 'you',
    name: 'You (David)',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCOkRMHyUX4qXKDeIqQ1cwtFidq525FUpVO1II9eABdzVmfcrxCHxlWf2oSifN9FGwcHc1W6Qc8WAQicNjJ5YCe2lUpd4GCRmmkzR0HZDdVQrsTKRs5topztIMy2JhmYrOe3yYMbbVUy32l9ypH_j0WkQQJNFokstSvc8bYUuof5Fw18a0WBq336ogQEi0jbM92VDl1KNTzPyw7GWx37rIWSth-ugO_dIU0KUCP2sfpSvUVtx6rJJ4ZCZYclh62aoLSAEOJ0FEs--hF',
    status: '',
    isSpeaking: false,
    isMuted: false,
    dataAlt: 'A man looking directly into the camera from a modern office. Bright, high-key lighting. Enterprise futuristic style.'
  }
];

export const initialActionItems: ActionItem[] = [
  {
    id: 'action-1',
    title: 'Finalize AI API integration spec',
    priority: 'URGENT',
    assignee: {
      name: 'Sarah J.',
      avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDSOb1gtLOioHpppdOZaKQA7QZaZmDxvoLIplK2Zl29P75KrHyBVWYqE7UnLv1QbJ6ZxVAk_yytFGMf4ami7-JVnBCOmGEmkOhj0E1LttJdRK8SylicZKPBsDVeGSuapMV0WktU0JI_huOLnql1hbaYfWzeSOHv-iyzcBgdtX1dDJ86hblDYo5nae7cNKM5Hu5Cknbj1slnlfJ4k7C8ddl8ASinBbYzTO20zEJVUQJI4P0TEB3fbh12IdG94bxoBZOlVYbYA20Lw9W6'
    },
    dueDate: 'Oct 26',
    completed: false
  },
  {
    id: 'action-2',
    title: 'Draft Q4 marketing brief',
    priority: 'NORMAL',
    assignee: {
      name: 'Mike K.',
      avatar: '' // MK initials
    },
    dueDate: 'Oct 28',
    completed: false
  },
  {
    id: 'action-3',
    title: 'Review rate limit metrics logs',
    priority: 'LOW',
    assignee: {
      name: 'David Y.',
      avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCvRD13_qzzAV0V2PpVLuJEFkyfFks-DVev33Wxbw5NAmWV_HfRvdQuVImFR02oROpkBI9sAp-4LYIElKI7Saitu633GWwDHutJV2oJZxzXszB3aRyMuoiEhXn7wkuUfgY5we2LTSpz7V4PmFLsfVW_SOkMdXimckkqtPFW2U8tfV47nlyWa5b1cMtbHHPYr1SNZLP_DM8n6_5TvMOji2K5F9T2NX3ywfB7k0D_5eqCBqhiAw-G2S9Ewia0MloW1AcdN9MXkIJTDHIZ'
    },
    dueDate: 'Oct 30',
    completed: true
  }
];

export const initialThreads: ChatThread[] = [
  {
    id: 'sarah-jenkins',
    name: 'Sarah Jenkins',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDIKHdL_gKET2TRMf6MHT6iXkz974_ytMmi0_bn0GaOgs1PyWBcZ5nSkivDyyPci9eUggBLyAcnMrX8A4NJyYdsUhsWZ59Z-AjE_oRC4ZlrYsSxRGRm5RobO6VUq69HuAkpDhB0niFNbcOWA2A6vk2c_ZTynM97aidb0fnn6HzkF0GDa7h7pWYwJ3oYxZMmfXSrNGFPIcg6fd1UAvnUQozXXnHeIa7D2fuN0FttkfQzivgS6_wegaZ81e4PBDU22WzDirqkkGZGCZOP',
    lastMessage: 'Excellent catch. Wants to jump on a quick sync to finalize?',
    time: 'Just now',
    unreadCount: 2,
    onlineStatus: 'online',
    messages: [
      {
        id: 'msg-1',
        sender: 'sarah',
        senderName: 'Sarah Jenkins',
        avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBTfNzdJUZEOfXlPAvtuBWfTSwBi_l3CV9Tpp5qT3XgnJJQv9IUCALeEQ6BDbOJJBv6AXgYXOvehl3OqqSlXzLm-RBPRhiVOxAar6kvrOV1tQ-MwT9wz90Ud8FyWqvBK2DTUjrRL6hRNIwd0wwoWqEhzoTMp_y-a_2hPuevEM0qc_x3B3cax2KaRuU5A3IWKAgNrxovxSF7x41He--OpoJNVEl8KsKA8yZ9U9r3admqCur6rlXWEu6OWIUQhW5JuPJ0zr3aQwfOSl2T',
        time: '10:24 AM',
        text: "The Q3 report looks solid. Let's review the final projections before the board meeting."
      },
      {
        id: 'msg-2',
        sender: 'user',
        senderName: 'You',
        time: '10:28 AM',
        text: "Agreed. I've attached the latest intelligence brief detailing the competitor analysis. The AI picked up a few interesting anomalies in their supply chain data."
      },
      {
        id: 'msg-3',
        sender: 'sarah',
        senderName: 'Sarah Jenkins',
        avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBH28lrt_s0dQBr4YaEwoSxRM1evajuSDz4rg7zPFgKVRVCnkmDOFBDP06uPlmfgvVoBfHlP3tezJYJiEapFz1eriU8zfwaj9EK6ZYmvjzlGWF6Wx102rJCJFzv-iW5rnNrO6vREA467WYufqniHklX_Ki-2ZaNZwvfKIo7fdqgIdgQp9OfDBWbFcTj0T6jYzX1bSBWSGwCdMHLpW5Xx4ExCkbcPt-61rfRz03cQIbgWuiPkNTA7NqxMeVQ5j3rIaJi_tjiJ-Op3rNU',
        time: 'Just now',
        text: "Excellent catch. I'll flag this for the executive summary. Want to jump on a quick sync to finalize?"
      }
    ]
  },
  {
    id: 'engineering-sync',
    name: 'Engineering Sync',
    initials: 'ENG',
    lastMessage: 'David: Pushed the final commit for the auto-purge routine...',
    time: '10:42 AM',
    onlineStatus: 'online',
    isGroup: true,
    messages: [
      {
        id: 'msg-sync-1',
        sender: 'marcus',
        senderName: 'Marcus Chen',
        time: '10:30 AM',
        text: "Are we on track for the security audit deployments tomorrow?"
      },
      {
        id: 'msg-sync-2',
        sender: 'user',
        senderName: 'David (You)',
        time: '10:42 AM',
        text: "Pushed the final commit for the auto-purge routine. Toggled on sandbox rules in the Swiss region."
      }
    ]
  },
  {
    id: 'marcus-chen',
    name: 'Marcus Chen',
    avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB8s9eCpTvJEBy0c5ajO3bIHrjgfAlY8ScVJDw3dE36Or-xCTHhUgUzGW2GdtQyTALJQ3W3xmahPQwuJ-aEyxDd9JaaaZigG034zpxMuhJHhM11JKSo3f2c17xu9iDVZB3x4am_67VeCE4GegYRHl75a7jGaq_genBoPQEJ2C2wwEjsg1FiCn1bTSH5GAw2PiPSQ1WcCoJF2yqK8GY0AaNO_bkQ0fckuyZLTwKkkNTY3pUOvvoAqaBXivV_qKx-ip88OFboAe8xZ4q5',
    lastMessage: "Can we reschedule tomorrow's one-on-one?",
    time: 'Yesterday',
    onlineStatus: 'offline',
    messages: [
      {
        id: 'msg-marcus-1',
        sender: 'marcus',
        senderName: 'Marcus Chen',
        time: 'Yesterday',
        text: "Can we reschedule tomorrow's one-on-one? I have to finalize the GDPR compliance reports."
      }
    ]
  }
];

export const initialComplianceLogs: ComplianceLog[] = [
  {
    id: 'log-1',
    timestamp: '2026-06-04 14:32:01 UTC',
    event: 'Auto-Purge Executed: Transcripts > 7 days',
    actor: 'SYSTEM',
    status: 'SUCCESS'
  },
  {
    id: 'log-2',
    timestamp: '2026-06-04 09:15:22 UTC',
    event: 'Recording Consent Overridden (Emergency Protocol)',
    actor: 'Admin: J. Doe',
    status: 'FLAGGED'
  },
  {
    id: 'log-3',
    timestamp: '2026-06-03 18:00:00 UTC',
    event: 'Data Sovereignty toggled ON (Swiss Data Center)',
    actor: 'Admin: M. Smith',
    status: 'SUCCESS'
  },
  {
    id: 'log-4',
    timestamp: '2026-06-02 11:22:15 UTC',
    event: 'E2E Key Rotation Initiated',
    actor: 'SYSTEM',
    status: 'SUCCESS'
  }
];

export const faqCategories = [
  {
    id: 'privacy',
    title: 'Privacy & Sovereignty',
    icon: 'shield_person',
    items: [
      'Data Residency Regions',
      'GDPR Compliance Setup',
      'Anonymization Protocols'
    ]
  },
  {
    id: 'encryption',
    title: 'Encryption Standards',
    icon: 'key',
    items: [
      'Key Management (KMS)',
      'End-to-End Configuration',
      'Rotating Security Keys'
    ]
  },
  {
    id: 'audits',
    title: 'Data Audits',
    icon: 'fact_check',
    items: [
      'Generating Audit Logs',
      'Exporting for Compliance',
      'Real-time Monitoring'
    ]
  },
  {
    id: 'security',
    title: 'Account Security',
    icon: 'admin_panel_settings',
    items: [
      'MFA Enforcements',
      'SSO Integrations',
      'Role-Based Access Control'
    ]
  }
];

export const FAQAnswers: Record<string, string> = {
  'Data Residency Regions': 'IB Connect routes all chats and sync files through selected secure geographical regions. Enabling "Data Sovereignty" migrates all stored transcripts and speech models to Swiss-based secure vaults.',
  'GDPR Compliance Setup': 'Under Settings > Compliance, you can configure automatic consent requirements. Transcripts are encrypted at rest with AES-256 and only accessible strictly to validated workspace session members.',
  'Anonymization Protocols': 'Text and transcripts feed into your choice of localized NLP tools. Proprietary PII scrubbers remove names, IP addresses, locations and financial data from transcript logs automatically before storage.',
  'Key Management (KMS)': 'Workspace admins can assign client-held keys (BYOK) stored in AWS KMS or Google Cloud KMS. Data cannot be decrypted or searched without the active KMS keys injected into the session.',
  'End-to-End Configuration': 'E2E Encryption shields video data and audio relays during live calls. All streams route dynamically via peer-to-peer enclaves when participants number under six.',
  'Rotating Security Keys': 'System keys rotate automatically every 24 hours. Users can force-reset active security locks on active audio enclaves directly from the Security sidepanel.',
  'Generating Audit Logs': 'Every session initialization, transcript download, or parameter change creates an immutable log block. View and download reports from the Compliance Audit Log component.',
  'Exporting for Compliance': 'Logs can be exported in standardized AES-256 encrypted CSV formats directly. Integrations support automatic sync with Splunk, Datadog, or secure cloud endpoints.',
  'Real-time Monitoring': 'Live anomaly detection alerts admins on abnormal transcript queries, foreign session connection attempts, or emergency consent overrides.',
  'MFA Enforcements': 'Toggle Multi-Factor Authentication requirements for all company users. Third-party authenticator apps or security keys (FIDO2) are supported.',
  'SSO Integrations': 'Integrate with Okta, Microsoft Entra ID (Azure AD), or Google Workspace SSO out-of-the-box using standard SAML 2.0 or OIDC connectors.',
  'Role-Based Access Control': 'Define customized access permissions (Admin, Compliance Auditor, Member) to restrict who can export compliance reports, join emergency syncs, or change data retention rules.'
};

export const featuredGuides = [
  {
    id: 'guide-1',
    title: 'Setting up Auto-Purge Timers',
    icon: 'timer',
    detail: 'Auto-Purge processes guarantee your team meets strict regulatory timelines. Setting "Transcript Retention" to 7 days will dispatch storage wipe workers every Sunday at 00:00 UTC to securely overwrite expired disk blocks with random noise.'
  },
  {
    id: 'guide-2',
    title: 'Understanding AES-256 Secured channels',
    icon: 'enhanced_encryption',
    detail: 'All communication metadata, chat transcripts, and database records use military-grade AES-256-GCM. Decryption keys are loaded strictly ephemerally within the user container space and are never stored alongside encrypted text blocks.'
  },
  {
    id: 'guide-3',
    title: 'Compliance Export Guide',
    icon: 'file_download',
    detail: 'For security auditiing, admins can prepare audited data reviews. This documentation guides you through verifying the cryptographic sign-offs in your exported CSV files to prove compliance to compliance inspectors.'
  }
];
