import {
    UserRole,
    userRole
} from '@manyfold/shared'
import { IsIn } from 'class-validator'

export class UpdateUserRoleDto {
    @IsIn([userRole.USER, userRole.ADMIN])
    role!: UserRole
}
