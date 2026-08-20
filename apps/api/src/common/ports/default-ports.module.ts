import { Global, Module } from '@nestjs/common'
import {
    ACQUISITION_PORT,
    noopAcquisitionPort
} from '@/common/ports/acquisition.ports'
import {
    EXPERIMENT_ASSIGNMENT_PORT,
    noExperimentsPort
} from '@/common/ports/experiment-assignment.ports'
import {
    BILLING_LIFECYCLE_PORT,
    noopBillingLifecyclePort
} from '@/common/ports/billing-lifecycle.ports'
import {
    CLOUD_COMPUTER_PORT,
    openCloudComputerPort
} from '@/common/ports/cloud-computer.ports'
import {
    USAGE_PERIOD_PORT,
    calendarUsagePeriodPort
} from '@/common/ports/usage-period.ports'
import {
    MANAGED_CHANNEL_GUARD_PORT,
    MANAGED_MODELS_PORT,
    MANAGED_PRICING_PORT,
    noManagedModelsPort,
    noManagedPricingPort,
    openManagedChannelGuard
} from '@/common/ports/managed-models.ports'

// The open-source binding of the editions ports: no growth attribution, no
// experiments, no billing lifecycle, no container commerce — every default is
// the do-nothing/allow-everything behavior a deployment without those
// businesses expects. A composition root imports exactly one ports module
// (this one here, CloudPortsModule in the cloud root); consumers must never
// provide these tokens locally — Nest resolves a consumer module's own
// providers before the global registry, so a local binding would silently
// shadow the root's choice.
@Global()
@Module({
    providers: [
        { provide: ACQUISITION_PORT, useValue: noopAcquisitionPort },
        { provide: EXPERIMENT_ASSIGNMENT_PORT, useValue: noExperimentsPort },
        {
            provide: BILLING_LIFECYCLE_PORT,
            useValue: noopBillingLifecyclePort
        },
        { provide: CLOUD_COMPUTER_PORT, useValue: openCloudComputerPort },
        { provide: USAGE_PERIOD_PORT, useValue: calendarUsagePeriodPort },
        { provide: MANAGED_MODELS_PORT, useValue: noManagedModelsPort },
        { provide: MANAGED_PRICING_PORT, useValue: noManagedPricingPort },
        {
            provide: MANAGED_CHANNEL_GUARD_PORT,
            useValue: openManagedChannelGuard
        }
    ],
    exports: [
        ACQUISITION_PORT,
        EXPERIMENT_ASSIGNMENT_PORT,
        BILLING_LIFECYCLE_PORT,
        CLOUD_COMPUTER_PORT,
        USAGE_PERIOD_PORT,
        MANAGED_MODELS_PORT,
        MANAGED_PRICING_PORT,
        MANAGED_CHANNEL_GUARD_PORT
    ]
})
export class DefaultPortsModule {}
