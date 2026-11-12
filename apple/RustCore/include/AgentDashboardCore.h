#ifndef AGENT_DASHBOARD_CORE_H
#define AGENT_DASHBOARD_CORE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct AdashDecisionStore AdashDecisionStore;
uint32_t adash_core_abi_version(void);
AdashDecisionStore *adash_decision_store_new(void);
void adash_decision_store_free(AdashDecisionStore *store);
void adash_decision_store_reset(AdashDecisionStore *store);
/* A store is confined to one thread. Caller frees the returned UTF-8 JSON string. */
char *adash_decision_store_apply(AdashDecisionStore *store, const uint8_t *bytes, size_t length);
void adash_core_string_free(char *string);
#ifdef __cplusplus
}
#endif
#endif
