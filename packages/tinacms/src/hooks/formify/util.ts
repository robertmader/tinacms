/**

*/

import { Form, Field, FormOptions, TinaCMS, AnyField } from '@tinacms/toolkit'
import { getIn } from 'final-form'

import type {
  DocumentBlueprint,
  FieldBlueprint,
  FormifiedDocumentNode,
  OnChangeEvent,
  FormNode,
  State,
  ChangeSet,
  BlueprintPath,
} from './types'
import { TinaSchema, resolveForm } from '@tinacms/schema-tools'

import {
  generateFormCreators,
  formifyCallback,
  transformDocumentIntoMutationRequestPayload,
  onSubmitArgs,
} from '../use-graphql-forms'
interface RecursiveFormifiedDocumentNode<T extends object>
  extends Array<RecursiveFormifiedDocumentNode<T> | T> {}

/**
 * Gets the value from an object for a given blueprint for _all_ possible values.
 * eg. If the blueprint is `getCollection.documents.edges.[].node` and the value is:
 * ```
 * {
 *   getCollection: {
 *      documents: {
 *        edges: [{
 *          node: valueA
 *        },
 *        {
 *          node: valueB
 *        }]
 *      }
 *   }
 * }
 * ```
 * The response would be an array containing `valueA` and `valueB`
 *
 */
export const getValueForBlueprint = <T extends object>(
  state: object,
  path: string
): RecursiveFormifiedDocumentNode<T> | T => {
  const pathArray = path.split('.')
  let latest = state
  pathArray.every((item, index) => {
    if (item === '[]') {
      const restOfItems = pathArray.slice(index + 1)
      if (latest) {
        const next = []
        if (Array.isArray(latest)) {
          latest.forEach((latest2, index) => {
            const res = getValueForBlueprint(latest2, restOfItems.join('.'))
            next.push(res)
          })
        } else {
          throw new Error(`Expected value to be an array for "[]" item`)
        }
        if (next.length > 0) {
          latest = next
        } else {
          latest = undefined
        }
      }
      return false
    } else {
      if (latest) {
        latest = latest[item]
      } else {
        latest = undefined
      }
    }
    return true
  })
  // @ts-ignore
  return latest
}

/**
 * Returns the name of the field. In the example query, `title` and `t` would both be blueprint fields
 *
 * ```graphql
 * {
 *   getPostDocument(relativePath: $relativePath) {
 *     data {
 *       title,
 *       t: title # here `t` is an alias for title
 *     }
 *   }
 * }
 * ```
 */
export const getFieldNameOrAlias = (fieldBlueprint: FieldBlueprint) => {
  return fieldBlueprint.path[fieldBlueprint.path.length - 1].alias
}

const spliceLocation = (string: string, location: number[]) => {
  const accum: (string | number)[] = []
  let counter = 0

  string.split('.').forEach((item) => {
    if (item === '[]') {
      accum.push(location[counter])
      counter++
    } else {
      accum.push(item)
    }
  })

  return accum.join('.')
}

const getPathToChange = (
  documentBlueprint: DocumentBlueprint | FieldBlueprint,
  formNode: FormNode,
  event: OnChangeEvent
) => {
  const fieldName = event.field.name
  const location = [...formNode.location, ...stripIndices(fieldName)]
  const accum: (string | number)[] = []
  let counter = 0
  documentBlueprint.path.forEach((item) => {
    accum.push(item.alias)
    if (item.list) {
      // If there's no match we're assuming it's a list field, and not an item within the list field
      // eg. blocks vs blocks.0
      if (location[counter] !== undefined) {
        accum.push(location[counter])
        counter++
      }
    }
  })

  return accum.join('.')
}

export const buildForm = (
  doc: FormifiedDocumentNode,
  cms: TinaCMS,
  formify: formifyCallback,
  showInSidebar: boolean = false,
  onSubmit?: (args: onSubmitArgs) => void
): Form => {
  const id = doc._internalSys.path
  const enrichedSchema: TinaSchema = cms.api.tina.schema
  const collection = enrichedSchema.getCollection(
    doc._internalSys.collection.name
  )
  const { createForm, createGlobalForm } = generateFormCreators(
    cms,
    showInSidebar,
    collection.ui?.global
  )
  const SKIPPED = 'SKIPPED'
  let form
  let skipped
  const skip = () => {
    skipped = SKIPPED
  }
  if (skipped) return

  const template = enrichedSchema.getTemplateForData({
    collection,
    data: doc._values,
  })
  const formCommon = {
    id,
    label: id,
    initialValues: doc._values,
    onSubmit: async (payload) => {
      try {
        // TODO: this all probably needs to come from TinaSchema
        const params = transformDocumentIntoMutationRequestPayload(payload, {
          // False because we're prefixing the params with the collection name before passing them in
          includeCollection: false,
          includeTemplate: !!collection.templates,
        })
        const variables = { params }
        const mutationString = `#graphql
          mutation UpdateDocument($collection: String!, $relativePath: String!, $params: DocumentUpdateMutation!) {
            updateDocument(collection: $collection, relativePath: $relativePath, params: $params) {
              __typename
            }
          }
        `
        if (onSubmit) {
          onSubmit({
            queryString: mutationString,
            mutationString,
            variables: {
              collection: doc._internalSys.collection.name,
              relativePath: doc._internalSys.relativePath,
              params: { [doc._internalSys.collection.name]: variables },
            },
          })
        } else {
          try {
            await cms.api.tina.request(mutationString, {
              variables: {
                collection: doc._internalSys.collection.name,
                relativePath: doc._internalSys.relativePath,
                params: {
                  [doc._internalSys.collection.name]: variables.params,
                },
              },
            })
            cms.alerts.success('Document saved!')
          } catch (e) {
            cms.alerts.error('There was a problem saving your document.')
            console.error(e)
          }
        }
      } catch (e) {
        console.error(e)
        cms.alerts.error('There was a problem saving your document.')
      }
    },
  }
  let formConfig = {} as FormOptions<any, AnyField>

  const formInfo = resolveForm({
    collection,
    basename: collection.name,
    schema: enrichedSchema,
    template,
  })
  formConfig = {
    label: formInfo.label,
    // TODO: return correct type
    fields: formInfo.fields as any,
    ...formCommon,
  }

  if (formify) {
    form = formify(
      {
        formConfig,
        createForm,
        createGlobalForm,
        skip,
      },
      cms
    )
  } else {
    form = createForm(formConfig)
  }

  if (!(form instanceof Form)) {
    if (skipped === SKIPPED) {
      return
    }
    throw new Error('formify must return a form or skip()')
  }

  return form
}

export const formNodeId = (formNode: FormNode) => {
  return (
    spliceLocation(formNode.documentBlueprintId, formNode.location) +
    formNode.documentFormId
  )
}
export const formNodePath = (formNode: FormNode) => {
  return spliceLocation(formNode.documentBlueprintId, formNode.location)
}

export const formNodeNotIn = (formNode: FormNode, formNodes: FormNode[]) => {
  return !formNodes.find((fn) => formNodeId(fn) === formNodeId(formNode))
}

export const sequential = async <A, B>(
  items: A[] | undefined,
  callback: (args: A, idx: number) => Promise<B>
) => {
  const accum: B[] = []
  if (!items) {
    return []
  }

  const reducePromises = async (previous: Promise<B>, endpoint: A) => {
    const prev = await previous
    // initial value will be undefined
    if (prev) {
      accum.push(prev)
    }

    return callback(endpoint, accum.length)
  }

  // @ts-ignore FIXME: this can be properly typed
  const result = await items.reduce(reducePromises, Promise.resolve())
  if (result) {
    // @ts-ignore FIXME: this can be properly typed
    accum.push(result)
  }

  return accum
}

const getFormNodesStartingWith = (string: string, state: State) => {
  return state.formNodes.filter((subFormNode) => {
    return subFormNode.documentBlueprintId.startsWith(string)
  })
}

export const getFormNodesForField = (
  fieldBlueprint: FieldBlueprint,
  formNode: FormNode,
  event: OnChangeEvent,
  state: State
) => {
  const pathToChange = getPathToChange(fieldBlueprint, formNode, event)
  const formNodes = getFormNodesStartingWith(fieldBlueprint.id, state)
  const eventLocation = [
    ...formNode.location,
    ...stripIndices(event.field.name),
  ]
  const existing = getIn(state.data, pathToChange)
  return { pathToChange, formNodes, eventLocation, existing }
}

export const getBlueprintAliasPath = (blueprint: DocumentBlueprint) => {
  const namePath = []
  const aliasPath = []
  blueprint.path.forEach((p) => {
    namePath.push(p.name)
    aliasPath.push(p.alias)
    if (p.list) {
      namePath.push('[]')
      aliasPath.push('[]')
    }
  })

  return aliasPath.join('.')
}

export const getFieldAliasForBlueprint = (path: BlueprintPath[]) => {
  const reversePath = [...path].reverse()
  const accum = []
  reversePath.every((item, index) => {
    if (index === 0) {
      if (item.list) {
        accum.push('[]')
      }
      accum.push(item.alias)
    } else {
      if (item.isNode) {
        return false
      }
      if (item.list) {
        accum.push('[]')
      }
      accum.push(item.alias)
    }
    return true
  })
  return accum.reverse().join('.')
}

/**
 *
 * Determines the appropriate fields which should recieve an update from a form change
 *
 * In cases where there's polymorphic blocks, it's possible that an update would affect
 * multiple locations that it shouldn't.
 *
 * An OnChange event name can look like: `blocks.2.title`, but if there are 2 block elements
 * with a field of the same name, an event name it wouldn't be enough information for us.
 *
 * To get around this, the event sends the current `typename` along with it, and we use that
 * to determine where in our blueprint the value should be updated.
 *
 */
export const getBlueprintFieldsForEvent = (
  blueprint: DocumentBlueprint,
  event: OnChangeEvent
) => {
  return blueprint.fields
    .filter((fbp) => {
      if (getBlueprintNamePath(fbp) === getEventPath(event, blueprint)) {
        return true
      }
    })
    .filter((fbp) => {
      return filterFieldBlueprintsByParentTypename(
        fbp,
        event.field.data.tinaField.parentTypename
      )
    })
}

export const filterFieldBlueprintsByParentTypename = (
  fbp: FieldBlueprint,
  typename
) => {
  let lastDisambiguator: string

  fbp.path.forEach((path) => {
    if (path.parentTypename) {
      lastDisambiguator = path.parentTypename
    }
  })
  if (lastDisambiguator) {
    return typename === lastDisambiguator
  } else {
    return true
  }
}

/**
 *
 * Returns the human-readable path to a blueprint or blueprint field.
 * Optionally, appends a disambiguator to the string where necessary.
 *
 * eg. if a blocks field is polymporphic, specifying `true` for the disambiguator
 *
 * ```
 * getPageDocument.data.blocks[].PageBlocksCta.title
 * ```
 */
export const getBlueprintNamePath = (
  blueprint: Pick<DocumentBlueprint, 'path'>,
  disambiguator?: boolean
) => {
  const namePath = []
  blueprint.path.forEach((p) => {
    if (disambiguator) {
      if (p.parentTypename) {
        namePath.push(p.parentTypename)
      }
    }
    namePath.push(p.name)
    if (p.list) {
      namePath.push('[]')
    }
  })

  return namePath.join('.')
}

/**
 *
 * Returns the path for the event, which uses `data.tinaField` metadata to
 * determine the shape of the field. For polymorphic objects it's necessary
 * to build-in the name of the GraphQL type that's receiving the change.
 *
 * Eg. when the title of a blocks "cta" template is changed, we might see an
 * event path like:
 * ```
 * getPageDocument.data.blocks.0.PageBlocksCta.title
 * ```
 */
const getEventPath = (
  event: OnChangeEvent,
  blueprint: DocumentBlueprint | FieldBlueprint
) => {
  const stringArray = event.field.name.split('.')
  const eventPath = stringArray
    .map((item) => {
      if (isNaN(Number(item))) {
        return item
      }
      return `[]`
    })
    .join('.')
  const items = [blueprint.id, eventPath]
  const isList = event.field.data.tinaField.list
  if (isList && !eventPath.endsWith('[]')) {
    items.push(`[]`)
  }
  return items.join('.')
}

export const stripIndices = (string) => {
  const accum = []
  const stringArray = string.split('.')
  stringArray.forEach((item) => {
    if (isNaN(item)) {
    } else {
      accum.push(Number(item))
    }
  })

  return accum
}

export const replaceRealNum = (string) => {
  const stringArray = string.split('.')
  return stringArray
    .map((item) => {
      if (isNaN(item)) {
        return item
      }
      return '[]'
    })
    .join('.')
}

export const getMatchName = ({ field, prefix, blueprint }) => {
  const fieldName = field.list ? `${field.name}.[]` : field.name
  const blueprintName = getBlueprintNamePath(blueprint)
  const extra = []
  if (prefix) {
    extra.push(prefix)
  }
  const matchName = [blueprintName, ...extra, fieldName].join('.')
  return { matchName, fieldName }
}

export const getFormNodesFromEvent = (state: State, event: OnChangeEvent) => {
  const formNodes = state.formNodes.filter(
    (formNode) => formNode.documentFormId === event.formId
  )
  return formNodes
}

export const printState = (state: State) => {
  let string = ''
  state.blueprints.forEach((blueprint) => {
    let bpString = `# Blueprint\n`
    bpString = bpString + `# ${blueprint.id}`
    bpString = bpString + `\n#`
    bpString = bpString + `\n# Documents for blueprint`
    bpString = bpString + `\n# ================`
    state.formNodes
      .filter((formNode) => formNode.documentBlueprintId === blueprint.id)
      .forEach((formNode) => {
        const newString = `# ${formNode.documentFormId}${
          blueprint.id.includes('[]')
            ? ` [${formNode.location.join(', ')}]`
            : ``
        }`
        bpString = bpString + `\n${newString}`
      })

    bpString = bpString + `\n#`
    bpString = bpString + `\n# Field blueprints`
    bpString = bpString + `\n# ================`
    blueprint.fields
      .filter((fbp) => fbp.documentBlueprintId === blueprint.id)
      .forEach((fbp) => {
        bpString = bpString + `\n# ${getFieldAliasForBlueprint(fbp.path)}`
        // bpString = bpString + `\n# ${getBlueprintAliasPath(fbp)}`
        // bpString = bpString + `\n# ${fbp.id}`
      })
    string = string + `${bpString}\n`
    string = string + '\n'
  })
  string = string + `\n${state.queryString}`

  return string
}

export const printEvent = (event: OnChangeEvent) => {
  return {
    type: event.type,
    value: event.value,
    previousValue: event.previousValue,
    mutationType: event.mutationType,
    formId: event.formId,
    field: {
      data: event.field?.data,
      name: event.field?.name,
    },
  }
}

export const getFormNodeBlueprint = (formNode: FormNode, state: State) => {
  return state.blueprints.find((d) => d.id === formNode.documentBlueprintId)
}

export const getMoveMapping = (existing, from, to) => {
  const newOrderObject: { [key: number]: number } = {}
  if (from < to) {
    existing.map((_, i) => {
      if (i === from) {
        newOrderObject[i] = to
        return
      }
      if (i > from) {
        if (i < to) {
          newOrderObject[i] = i - 1
          return
        } else {
          if (i === to) {
            newOrderObject[i] = i - 1
            return
          }
          newOrderObject[i] = i
          return
        }
      } else {
        newOrderObject[i] = i
        return
      }
    })
  } else {
    existing.map((_, i) => {
      if (i === from) {
        newOrderObject[i] = to
        return
      }
      if (i > to) {
        if (i < from) {
          newOrderObject[i] = i + 1
          return
        } else {
          newOrderObject[i] = i
          return
        }
      } else {
        if (i === to) {
          newOrderObject[i] = i + 1
          return
        }
        newOrderObject[i] = i
        return
      }
    })
  }
  return newOrderObject
}

export const matchLocation = (eventLocation: number[], formNode: FormNode) => {
  return eventLocation.every((item, index) => item === formNode.location[index])
}

export const bumpLocation = (location: number[]) => {
  return location.map((item, index) => {
    // Bump the last item in the location array by 1, assuming "at" is always 0
    if (index === location.length - 1) {
      return item + 1
    }
    return item
  })
}

export const maybeLowerLocation = (location: number[], at: number) => {
  return location.map((item, index) => {
    // Bump the last item in the location array by 1, assuming "at" is always 0
    if (index === location.length - 1) {
      return item < at ? item : item - 1
    }
    return item
  })
}

export const matchesAt = (location: number[], at: number) => {
  let matches = false
  location.map((item, index) => {
    // Bump the last item in the location array by 1, assuming "at" is always 0
    if (index === location.length - 1) {
      if (item === at) {
        matches = true
      }
    }
  })
  return matches
}

export const swapLocation = (
  location: number[],
  mapping: { [key: number]: number }
) => {
  return location.map((item, index) => {
    if (index === location.length - 1) {
      return mapping[item]
    }
    return item
  })
}

/**
 *
 * Gets the sub-fields for an object field, if it's a polymorphic
 * object then we also need to get the __typename, though
 * we should probably supply that regardless. The current downside
 * of this is that it needs to come from the server because we
 * have no way of knowing what it would be from the client-side
 */
export const getSubFields = (
  changeSet: ChangeSet
): { fields: Field[]; __typename: string } => {
  // @ts-ignore FIXME: import types from newly-defined defineSchema
  const fields = changeSet.fieldDefinition.fields
    ? // @ts-ignore FIXME: import types from newly-defined defineSchema
      changeSet.fieldDefinition.fields
    : // @ts-ignore FIXME: import types from newly-defined defineSchema
      changeSet.fieldDefinition.templates[changeSet.value[0]._template].fields

  let __typename
  // @ts-ignore FIXME: import types from newly-defined defineSchema
  if (changeSet.fieldDefinition?.templates) {
    // @ts-ignore FIXME: import types from newly-defined defineSchema
    __typename = changeSet.fieldDefinition.typeMap[changeSet.value[0]._template]
  }

  return { fields, __typename }
}
