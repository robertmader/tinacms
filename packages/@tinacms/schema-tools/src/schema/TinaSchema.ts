/**

*/

import {
  TinaCloudSchemaEnriched,
  TinaCloudSchemaBase,
  TinaCloudCollection,
  Templateable,
  Collectable,
  CollectionTemplateable,
  TinaFieldEnriched,
} from '../types/index'
import { lastItem, assertShape } from '../util'

type Version = {
  fullVersion: string
  major: string
  minor: string
  patch: string
}

type Meta = {
  flags?: string[]
}

/**
 * TinaSchema is responsible for allowing you to look up certain
 * properties of the user-provided schema with ease.
 *
 */
export class TinaSchema {
  public schema: TinaCloudSchemaEnriched
  /**
   *
   * Create a schema class from a user defined schema object
   *
   * @param  {{version?:Version;meta?:Meta}&TinaCloudSchemaBase} config
   */
  constructor(
    public config: { version?: Version; meta?: Meta } & TinaCloudSchemaBase
  ) {
    // @ts-ignore
    this.schema = config
  }
  public getIsTitleFieldName = (collection: string) => {
    const col = this.getCollection(collection)
    const field = col?.fields?.find((x) => x.type === 'string' && x.isTitle)
    return field?.name
  }

  public getCollectionsByName = (collectionNames: string[]) => {
    return this.schema.collections.filter((collection) =>
      collectionNames.includes(collection.name)
    )
  }
  public getAllCollectionPaths = () => {
    const paths = this.getCollections().map(
      (collection) => `${collection.path}${collection.match || ''}`
    )
    return paths
  }
  public getCollection = (
    collectionName: string
  ): TinaCloudCollection<true> => {
    const collection = this.schema.collections.find(
      (collection) => collection.name === collectionName
    )
    if (!collection) {
      throw new Error(`Expected to find collection named ${collectionName}`)
    }
    const extraFields: { [key: string]: object[] } = {}
    const templateInfo = this.getTemplatesForCollectable(collection)
    switch (templateInfo.type) {
      case 'object':
        extraFields['fields'] = templateInfo.template.fields
        break
      case 'union':
        extraFields['templates'] = templateInfo.templates
        break
    }
    return {
      // @ts-ignore FIXME: backwards compatibility, using `slug` should probably be deprecated
      slug: collection.name,
      ...extraFields,
      ...collection,
      format: collection.format || 'md',
    }
  }
  public getCollections = () => {
    return (
      this.schema.collections.map((collection) =>
        this.getCollection(collection.name)
      ) || []
    )
  }
  public getGlobalTemplate = (templateName: string) => {
    const globalTemplate = this.schema.templates?.find(
      (template) => template.name === templateName
    )
    if (!globalTemplate) {
      throw new Error(
        `Expected to find global template of name ${templateName}`
      )
    }
    return globalTemplate
  }
  public getCollectionByFullPath = (filepath: string) => {
    const possibleCollections = this.getCollections().filter((collection) => {
      return filepath
        .replace(/\\/g, '/')
        .startsWith(collection.path.replace(/\/?$/, '/'))
    })

    // No matches
    if (possibleCollections.length === 0) {
      throw new Error(`Unable to find collection for file at ${filepath}`)
    }
    // One match
    if (possibleCollections.length === 1) {
      return possibleCollections[0]
    }
    if (possibleCollections.length > 1) {
      /**
       * If there are multiple matches, we want to return the collection
       * with the longest path.
       *
       * This is to handle the case where a collection is nested
       * inside another collection.
       *
       * For example:
       *
       * Collection 1:
       * ```
       * {
       *  name: 'Collection 1',
       *  path : 'content'
       * }
       * ```
       *
       * Collection 2:
       *
       * {
       *  name: 'Collection 2',
       *  path : 'content/posts'
       * }
       *
       * For example if we have a file at `content/posts/hello-world.md` it will match on collection 2.
       * Even though it also matches collection 1.
       *
       */
      const longestMatch = possibleCollections.reduce((acc, collection) => {
        if (collection.path.length > acc.path.length) {
          return collection
        }
        return acc
      })
      return longestMatch
    }
  }
  public getCollectionAndTemplateByFullPath = (
    filepath: string,
    templateName?: string
  ): {
    collection: TinaCloudCollection<true>
    template: Templateable
  } => {
    let template
    const collection = this.getCollectionByFullPath(filepath)

    const templates = this.getTemplatesForCollectable(collection)
    if (templates.type === 'union') {
      if (templateName) {
        template = templates.templates.find(
          (template) => lastItem(template.namespace) === templateName
        )
        if (!template) {
          throw new Error(
            `Unable to determine template for item at ${filepath}`
          )
        }
      } else {
        throw new Error(
          `Unable to determine template for item at ${filepath}, no template name provided for collection with multiple templates`
        )
      }
    }
    if (templates.type === 'object') {
      template = templates.template
    }
    if (!template) {
      throw new Error(
        `Something went wrong while trying to determine template for ${filepath}`
      )
    }

    return { collection: collection, template: template }
  }
  public getTemplateForData = ({
    data,
    collection,
  }: {
    data?: unknown
    collection: Collectable
  }): Templateable => {
    const templateInfo = this.getTemplatesForCollectable(collection)
    switch (templateInfo.type) {
      case 'object':
        return templateInfo.template
      case 'union':
        assertShape<{ _template: string }>(data, (yup) =>
          yup.object({ _template: yup.string().required() })
        )
        const template = templateInfo.templates.find(
          (template) =>
            template.namespace[template.namespace.length - 1] === data._template
        )
        if (!template) {
          // TODO: This should be a tina error
          throw new Error(
            `Expected to find template named '${
              data._template
            }' for collection '${lastItem(collection.namespace)}'`
          )
        }
        return template
    }
  }

  public transformPayload = (collectionName: string, payload: object) => {
    const collection = this.getCollection(collectionName)
    if (collection.templates) {
      const template = collection.templates.find((template) => {
        if (typeof template === 'string') {
          throw new Error('Global templates not supported')
        }
        return payload['_template'] === template.name
      })
      if (!template) {
        console.error(payload)
        throw new Error(`Unable to find template for payload`)
      }
      if (typeof template === 'string') {
        throw new Error('Global templates not supported')
      }
      return {
        [collectionName]: {
          [template.name]: this.transformCollectablePayload(payload, template),
        },
      }
    } else {
      return {
        [collectionName]: this.transformCollectablePayload(payload, collection),
      }
    }
  }
  private transformCollectablePayload = (
    payload: object,
    collection: Collectable
  ) => {
    const accumulator = {}
    Object.entries(payload).forEach(([key, value]) => {
      if (typeof collection.fields === 'string') {
        throw new Error('Global templates not supported')
      }
      const field = collection.fields.find((field) => {
        if (typeof field === 'string') {
          throw new Error('Global templates not supported')
        }
        return field.name === key
      })
      if (field) {
        accumulator[key] = this.transformField(field, value)
      }
    })
    return accumulator
  }

  private transformField = (field: TinaFieldEnriched, value: unknown) => {
    if (field.type === 'object')
      if (field.templates) {
        if (field.list) {
          assertShape<{ _template: string }[]>(value, (yup) =>
            yup.array(yup.object({ _template: yup.string().required() }))
          )
          return value.map((item) => {
            const { _template, ...rest } = item
            const template = field.templates.find((template) => {
              if (typeof template === 'string') {
                return false
              }
              return template.name === _template
            })
            if (typeof template === 'string') {
              throw new Error('Global templates not supported')
            }
            return {
              [_template]: this.transformCollectablePayload(rest, template),
            }
          })
        } else {
          assertShape<{ _template: string }>(value, (yup) =>
            yup.object({ _template: yup.string().required() })
          )
          const { _template, ...rest } = value
          return { [_template]: this.transformCollectablePayload(rest, field) }
        }
      } else {
        if (field.list) {
          assertShape<object[]>(value, (yup) => yup.array(yup.object()))
          return value.map((item) => {
            return this.transformCollectablePayload(item, field)
          })
        } else {
          assertShape<object>(value, (yup) => yup.object())
          return this.transformCollectablePayload(value, field)
        }
      }
    else {
      return value
    }
  }

  public isMarkdownCollection = (collectionName: string) => {
    const collection = this.getCollection(collectionName)
    const format = collection.format
    // markdown by default
    if (!format) {
      return true
    }
    if (['markdown', 'md'].includes(format)) {
      return true
    }
    return false
  }

  /**
   * Gets the template or templates from the item.
   * Both `object` fields and collections support
   * the ability for an object to be polymorphic,
   * and if it is, we need to build unions, which
   * are more of a headache for non-polymorphic
   * needs, so we also need the ability to just
   * build object types
   *
   *
   */
  public getTemplatesForCollectable = (
    collection: Collectable
  ): CollectionTemplateable => {
    let extraFields: TinaFieldEnriched[] = []
    if (collection.references) {
      extraFields = collection.references
    }
    if (collection.fields) {
      const template =
        typeof collection.fields === 'string'
          ? this.getGlobalTemplate(collection.fields)
          : collection

      if (
        typeof template.fields === 'string' ||
        typeof template.fields === 'undefined'
      ) {
        throw new Error('Exptected template to have fields but none were found')
      }

      return {
        namespace: collection.namespace,
        type: 'object',
        // @ts-ignore FIXME: Templateable should have a 'name' property
        template: {
          ...template,
          fields: [...template.fields, ...extraFields],
        },
      }
    } else {
      if (collection.templates) {
        return {
          namespace: collection.namespace,
          type: 'union',
          templates: collection.templates.map((templateOrTemplateString) => {
            const template =
              typeof templateOrTemplateString === 'string'
                ? this.getGlobalTemplate(templateOrTemplateString)
                : templateOrTemplateString
            return {
              ...template,
              fields: [...template.fields, ...extraFields],
            }
          }),
        }
      } else {
        throw new Error(
          `Expected either fields or templates array to be defined on collection ${collection.namespace.join(
            '_'
          )}`
        )
      }
    }
  }
}
