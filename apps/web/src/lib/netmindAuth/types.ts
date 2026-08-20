export interface NetmindUser {
    userSystemCode: string
    email: string
    nickName?: string
    loginToken: string
    [key: string]: unknown
}

// Returned by userCallBack when a third-party account needs binding to a
// NetMind account before a loginToken can be issued.
export interface AuthBindInfo {
    bandType: number // 1: needs email+code, 2: confirm third-party email, 3: bind existing
    identifyCode: string
    thirdEmail?: string
    canBandEmail?: string
    canBandNick?: string
}

export interface NetmindLoginPayload {
    loginToken?: string
    user?: NetmindUser
}